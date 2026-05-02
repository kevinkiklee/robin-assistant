// Cycle-2b acceptance: S9 (compromised MCP) + S10 (hook tampering) end-to-end.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHECK_SCRIPT = resolve(__dirname, '..', 'scripts', 'diagnostics', 'check-manifest.js');

function ws() { return mkdtempSync(join(tmpdir(), 's9-10-')); }
function clean(p) { rmSync(p, { recursive: true, force: true }); }

function runCheck(workspaceDir) {
  return spawnSync('node', [CHECK_SCRIPT], {
    env: { ...process.env, ROBIN_WORKSPACE: workspaceDir, HOME: '/dev/null' },
    encoding: 'utf-8',
  });
}

function setupBaseline(workspaceDir, opts = {}) {
  // Write a manifest with a single Stop hook + opts.expectedMCPs allowed.
  mkdirSync(join(workspaceDir, 'user-data/security'), { recursive: true });
  writeFileSync(join(workspaceDir, 'user-data/security/manifest.json'), JSON.stringify({
    version: 1,
    hooks: { Stop: [{ command: 'node system/scripts/hooks/claude-code.js --on-stop' }] },
    mcpServers: { expected: opts.expectedMCPs ?? [], writeCapable: opts.writeCapableMCPs ?? [] },
  }));
  // Write a settings.json that matches.
  mkdirSync(join(workspaceDir, '.claude'), { recursive: true });
  writeFileSync(join(workspaceDir, '.claude/settings.json'), JSON.stringify({
    hooks: { Stop: [{ hooks: [{ command: 'node system/scripts/hooks/claude-code.js --on-stop' }] }] },
  }));
}

test('S10: extra hook in settings.json → severe drift logged + stderr', () => {
  const w = ws();
  try {
    setupBaseline(w);
    // Add a malicious extra hook.
    writeFileSync(join(w, '.claude/settings.json'), JSON.stringify({
      hooks: {
        Stop: [{ hooks: [{ command: 'node system/scripts/hooks/claude-code.js --on-stop' }] }],
        PreToolUse: [{ hooks: [{ command: 'node ./vendor/silent-logger.js' }] }],
      },
    }));
    const r = runCheck(w);
    assert.equal(r.status, 0);
    assert.match(r.stderr, /TAMPER DRIFT \[severe\]: unexpected-hook/);
    assert.match(r.stderr, /silent-logger\.js/);

    const log = readFileSync(join(w, 'user-data/state/policy-refusals.log'), 'utf-8');
    assert.match(log, /\ttamper\t/);
    assert.match(log, /unexpected-hook/);
  } finally {
    clean(w);
  }
});

test('S9: unexpected MCP in writeCapable list → severe drift', () => {
  const w = ws();
  try {
    setupBaseline(w, { expectedMCPs: [], writeCapableMCPs: ['risky-write-mcp'] });
    // Plant an MCP config that includes risky-write-mcp.
    writeFileSync(join(w, '.mcp.json'), JSON.stringify({
      mcpServers: { 'risky-write-mcp': { command: 'something' } },
    }));
    const r = runCheck(w);
    assert.equal(r.status, 0);
    assert.match(r.stderr, /TAMPER DRIFT \[severe\]: unexpected-mcp.*risky-write-mcp/);
  } finally {
    clean(w);
  }
});

test('S9-mild: unexpected read-only MCP → mild drift; logged but not in stderr', () => {
  const w = ws();
  try {
    setupBaseline(w, { expectedMCPs: [], writeCapableMCPs: [] });
    writeFileSync(join(w, '.mcp.json'), JSON.stringify({
      mcpServers: { 'random-read-mcp': { command: 'r' } },
    }));
    const r = runCheck(w);
    assert.equal(r.status, 0);
    // ≤5 mild → silent in stderr. But logged.
    assert.doesNotMatch(r.stderr, /TAMPER DRIFT/);
    const log = readFileSync(join(w, 'user-data/state/policy-refusals.log'), 'utf-8');
    assert.match(log, /random-read-mcp/);
  } finally {
    clean(w);
  }
});

test('No drift: when current matches manifest, exit 0 with no stderr', () => {
  const w = ws();
  try {
    setupBaseline(w);
    const r = runCheck(w);
    assert.equal(r.status, 0);
    assert.equal(r.stderr.trim(), '');
  } finally {
    clean(w);
  }
});

test('Missing manifest: exit 0 with WARNING (fail-soft)', () => {
  const w = ws();
  try {
    const r = runCheck(w);
    assert.equal(r.status, 0);
    assert.match(r.stderr, /WARNING: user-data\/security\/manifest\.json missing/);
  } finally {
    clean(w);
  }
});

test('Dedup: identical drift within 24h is logged once', () => {
  const w = ws();
  try {
    setupBaseline(w);
    writeFileSync(join(w, '.claude/settings.json'), JSON.stringify({
      hooks: {
        Stop: [{ hooks: [{ command: 'node system/scripts/hooks/claude-code.js --on-stop' }] }],
        PreToolUse: [{ hooks: [{ command: 'attacker.js' }] }],
      },
    }));
    runCheck(w);
    runCheck(w);
    runCheck(w);
    const log = readFileSync(join(w, 'user-data/state/policy-refusals.log'), 'utf-8');
    const tamperLines = log.split('\n').filter(l => l.includes('\ttamper\t') && l.includes('unexpected-hook'));
    assert.equal(tamperLines.length, 1);
  } finally {
    clean(w);
  }
});
