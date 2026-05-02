import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadManifest,
  writeManifest,
  ensureManifestFromScaffold,
  loadCurrentSettings,
  enumerateMCPServers,
} from '../scripts/lib/manifest.js';
import { computeDrift, emitDrift } from '../scripts/check-manifest.js';

function ws() { return mkdtempSync(join(tmpdir(), 'manifest-')); }
function clean(p) { rmSync(p, { recursive: true, force: true }); }

function writeJson(path, data) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2));
}

test('loadManifest: returns null for missing file', () => {
  const w = ws();
  try {
    assert.equal(loadManifest(w), null);
  } finally {
    clean(w);
  }
});

test('loadManifest: returns null for malformed JSON', () => {
  const w = ws();
  try {
    mkdirSync(join(w, 'user-data/security'), { recursive: true });
    writeFileSync(join(w, 'user-data/security/manifest.json'), 'not json');
    assert.equal(loadManifest(w), null);
  } finally {
    clean(w);
  }
});

test('loadManifest: backfills missing v2 fields (cycle-2c forward-compat)', () => {
  const w = ws();
  try {
    writeJson(join(w, 'user-data/security/manifest.json'), { version: 1, hooks: {}, mcpServers: { expected: [] } });
    const m = loadManifest(w);
    assert.equal(m.version, 1);
    assert.deepEqual(m.agentsmd, { hardRulesHash: '', lastSnapshot: '' });
    assert.deepEqual(m.userDataJobs, { knownFiles: [] });
  } finally {
    clean(w);
  }
});

test('writeManifest: round-trips via loadManifest', () => {
  const w = ws();
  try {
    writeManifest(w, { version: 1, hooks: { Stop: [{ command: 'x' }] }, mcpServers: { expected: ['a'], writeCapable: [] } });
    const m = loadManifest(w);
    assert.equal(m.hooks.Stop[0].command, 'x');
    assert.equal(m.mcpServers.expected[0], 'a');
  } finally {
    clean(w);
  }
});

test('ensureManifestFromScaffold: copies scaffold when live missing', () => {
  const w = ws();
  try {
    mkdirSync(join(w, 'system/scaffold/security'), { recursive: true });
    writeFileSync(
      join(w, 'system/scaffold/security/manifest.json'),
      JSON.stringify({ version: 1, hooks: {}, mcpServers: { expected: [], writeCapable: [] } })
    );
    const r = ensureManifestFromScaffold(w);
    assert.equal(r.copied, true);
    assert.equal(existsSync(join(w, 'user-data/security/manifest.json')), true);
  } finally {
    clean(w);
  }
});

test('ensureManifestFromScaffold: does not overwrite existing live manifest', () => {
  const w = ws();
  try {
    mkdirSync(join(w, 'system/scaffold/security'), { recursive: true });
    writeFileSync(join(w, 'system/scaffold/security/manifest.json'), '{"scaffold": true}');
    mkdirSync(join(w, 'user-data/security'), { recursive: true });
    writeFileSync(join(w, 'user-data/security/manifest.json'), '{"live": true}');
    const r = ensureManifestFromScaffold(w);
    assert.equal(r.copied, false);
    const cur = readFileSync(join(w, 'user-data/security/manifest.json'), 'utf-8');
    assert.match(cur, /"live": true/);
  } finally {
    clean(w);
  }
});

test('enumerateMCPServers: reads project .mcp.json', () => {
  const w = ws();
  try {
    writeJson(join(w, '.mcp.json'), { mcpServers: { 'project-mcp-1': {}, 'project-mcp-2': {} } });
    const out = enumerateMCPServers(w);
    assert.ok(out.includes('project-mcp-1'));
    assert.ok(out.includes('project-mcp-2'));
  } finally {
    clean(w);
  }
});

test('enumerateMCPServers: returns sorted deduped list, empty when no configs', () => {
  const w = ws();
  try {
    const out = enumerateMCPServers(w);
    assert.ok(Array.isArray(out));
    // No project .mcp.json + global may or may not be present in CI; cannot assert empty.
    // But assert sorted + unique.
    const sorted = [...out].sort();
    assert.deepEqual(out, sorted);
    assert.equal(new Set(out).size, out.length);
  } finally {
    clean(w);
  }
});

test('computeDrift: no drift when current matches manifest', () => {
  const expected = {
    hooks: { Stop: [{ command: 'cmd1' }] },
    mcpServers: { expected: ['mcp-a'], writeCapable: [] },
  };
  const settings = { hooks: { Stop: [{ hooks: [{ command: 'cmd1' }] }] } };
  const mcps = ['mcp-a'];
  const drift = computeDrift(expected, settings, mcps);
  assert.deepEqual(drift, []);
});

test('computeDrift: severe drift on unexpected hook', () => {
  const expected = { hooks: { Stop: [{ command: 'cmd1' }] }, mcpServers: { expected: [], writeCapable: [] } };
  const settings = { hooks: { Stop: [{ hooks: [{ command: 'cmd-attacker' }] }] } };
  const drift = computeDrift(expected, settings, []);
  assert.equal(drift.length, 1);
  assert.equal(drift[0].severity, 'severe');
  assert.equal(drift[0].kind, 'unexpected-hook');
});

test('computeDrift: mild drift on unknown read-only MCP', () => {
  const expected = { hooks: {}, mcpServers: { expected: ['known'], writeCapable: [] } };
  const drift = computeDrift(expected, { hooks: {} }, ['known', 'unknown']);
  assert.equal(drift.length, 1);
  assert.equal(drift[0].severity, 'mild');
  assert.equal(drift[0].kind, 'unexpected-mcp');
});

test('computeDrift: severe drift on unknown write-capable MCP', () => {
  const expected = { hooks: {}, mcpServers: { expected: [], writeCapable: ['risky'] } };
  const drift = computeDrift(expected, { hooks: {} }, ['risky']);
  assert.equal(drift.length, 1);
  assert.equal(drift[0].severity, 'severe');
  assert.match(drift[0].detail, /write-capable/);
});

test('emitDrift: writes refusal-log entries for non-info drift', () => {
  const w = ws();
  try {
    const drift = [
      { severity: 'severe', kind: 'unexpected-hook', detail: 'attack', hash: 'h1' },
      { severity: 'mild', kind: 'unexpected-mcp', detail: 'new-mcp', hash: 'h2' },
    ];
    // Capture stderr.
    const origStderr = process.stderr.write;
    let stderrOut = '';
    process.stderr.write = (s) => { stderrOut += s; return true; };
    try {
      emitDrift(w, drift);
    } finally {
      process.stderr.write = origStderr;
    }
    assert.match(stderrOut, /TAMPER DRIFT \[severe\]: unexpected-hook/);

    const log = readFileSync(join(w, 'user-data/state/policy-refusals.log'), 'utf-8');
    assert.match(log, /\ttamper\t/);
    assert.equal(log.split('\n').filter(Boolean).length, 2);
  } finally {
    clean(w);
  }
});

test('emitDrift: empty drift is a no-op', () => {
  const w = ws();
  try {
    emitDrift(w, []);
    assert.equal(existsSync(join(w, 'user-data/state/policy-refusals.log')), false);
  } finally {
    clean(w);
  }
});
