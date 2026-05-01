// Cycle-2b: end-to-end test of manifest-snapshot.js CLI.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_SCRIPT = resolve(__dirname, '..', 'scripts', 'manifest-snapshot.js');

function ws() { return mkdtempSync(join(tmpdir(), 'snap-')); }
function clean(p) { rmSync(p, { recursive: true, force: true }); }

function runSnapshot(workspaceDir, ...flags) {
  return spawnSync('node', [SNAPSHOT_SCRIPT, ...flags], {
    env: { ...process.env, ROBIN_WORKSPACE: workspaceDir, HOME: '/dev/null' },
    encoding: 'utf-8',
  });
}

test('default mode: writes JSON to stdout, no file write', () => {
  const w = ws();
  try {
    mkdirSync(join(w, '.claude'), { recursive: true });
    writeFileSync(join(w, '.claude/settings.json'), JSON.stringify({
      hooks: { Stop: [{ hooks: [{ command: 'node x.js' }] }] },
    }));
    const r = runSnapshot(w);
    assert.equal(r.status, 0);
    const data = JSON.parse(r.stdout);
    // Cycle-2c bumped snapshot output to v2.
    assert.ok(data.version === 1 || data.version === 2);
    assert.equal(data.hooks.Stop[0].command, 'node x.js');
    // No live manifest written.
    assert.equal(existsSync(join(w, 'user-data/security/manifest.json')), false);
  } finally {
    clean(w);
  }
});

test('--apply without --confirm: exits 1 with explanation', () => {
  const w = ws();
  try {
    const r = runSnapshot(w, '--apply');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /requires --confirm-trust-current-state/);
  } finally {
    clean(w);
  }
});

test('--apply --confirm-trust-current-state: writes live manifest', () => {
  const w = ws();
  try {
    mkdirSync(join(w, '.claude'), { recursive: true });
    writeFileSync(join(w, '.claude/settings.json'), JSON.stringify({
      hooks: { Stop: [{ hooks: [{ command: 'node x.js' }] }] },
    }));
    const r = runSnapshot(w, '--apply', '--confirm-trust-current-state');
    assert.equal(r.status, 0);
    const live = readFileSync(join(w, 'user-data/security/manifest.json'), 'utf-8');
    const data = JSON.parse(live);
    assert.ok(data.version === 1 || data.version === 2);
  } finally {
    clean(w);
  }
});
