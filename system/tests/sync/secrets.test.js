import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSecrets, requireSecret, saveSecret } from '../../scripts/lib/sync/secrets.js';

function setup() {
  const ws = mkdtempSync(join(tmpdir(), 'secrets-'));
  mkdirSync(join(ws, 'user-data/secrets'), { recursive: true });
  return ws;
}

// Cycle-2a: loadSecrets is now a no-op shim. Tests reflect the new API.
test('loadSecrets is a no-op shim that requires workspaceDir', () => {
  const ws = setup();
  // Existence check: doesn't throw with a workspaceDir, doesn't pollute env.
  loadSecrets(ws);
  rmSync(ws, { recursive: true });
});

test('loadSecrets requires workspaceDir (no implicit default)', () => {
  assert.throws(() => loadSecrets(), /workspaceDir is required/);
  assert.throws(() => loadSecrets(undefined), /workspaceDir is required/);
  assert.throws(() => loadSecrets(''), /workspaceDir is required/);
});

test('requireSecret throws when key missing in .env', () => {
  const ws = setup();
  writeFileSync(join(ws, 'user-data/secrets/.env'), 'OTHER=value\n');
  assert.throws(() => requireSecret(ws, 'MISSING_KEY'), /Missing secret: MISSING_KEY/);
  rmSync(ws, { recursive: true });
});

test('requireSecret returns the value when present in .env', () => {
  const ws = setup();
  writeFileSync(join(ws, 'user-data/secrets/.env'), 'PRESENT_KEY=value\n');
  assert.equal(requireSecret(ws, 'PRESENT_KEY'), 'value');
  rmSync(ws, { recursive: true });
});

test('saveSecret creates .env when missing and adds the key', () => {
  const ws = setup();
  saveSecret(ws, 'NEW_KEY', 'new-value');
  const content = readFileSync(join(ws, 'user-data/secrets/.env'), 'utf-8');
  assert.match(content, /^NEW_KEY=new-value\n/);
  rmSync(ws, { recursive: true });
});

test('saveSecret replaces an existing key in place', () => {
  const ws = setup();
  writeFileSync(
    join(ws, 'user-data/secrets/.env'),
    '# leading comment\nFOO=old\nBAR=stable\n'
  );
  saveSecret(ws, 'FOO', 'new');
  const content = readFileSync(join(ws, 'user-data/secrets/.env'), 'utf-8');
  assert.equal(content, '# leading comment\nFOO=new\nBAR=stable\n');
  rmSync(ws, { recursive: true });
});

test('saveSecret appends a new key at the end, preserving comments', () => {
  const ws = setup();
  writeFileSync(
    join(ws, 'user-data/secrets/.env'),
    '# leading\nFOO=existing\n# trailing\n'
  );
  saveSecret(ws, 'NEW', 'val');
  const content = readFileSync(join(ws, 'user-data/secrets/.env'), 'utf-8');
  assert.equal(content, '# leading\nFOO=existing\n# trailing\nNEW=val\n');
  rmSync(ws, { recursive: true });
});

test('saveSecret writes atomically (no .tmp left behind)', () => {
  const ws = setup();
  saveSecret(ws, 'K', 'v');
  assert.ok(!existsSync(join(ws, 'user-data/secrets/.env.tmp')));
  rmSync(ws, { recursive: true });
});
