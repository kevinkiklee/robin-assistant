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

test('loadSecrets parses KEY=value lines and skips comments and blanks', () => {
  const ws = setup();
  writeFileSync(
    join(ws, 'user-data/secrets/.env'),
    '# comment\nFOO=bar\n\nBAZ=qux\n# inline-style ignored\n'
  );
  delete process.env.FOO;
  delete process.env.BAZ;
  loadSecrets(ws);
  assert.equal(process.env.FOO, 'bar');
  assert.equal(process.env.BAZ, 'qux');
  rmSync(ws, { recursive: true });
});

test('loadSecrets does not override pre-existing process.env values', () => {
  const ws = setup();
  writeFileSync(join(ws, 'user-data/secrets/.env'), 'FOO=from-file\n');
  process.env.FOO = 'from-env';
  loadSecrets(ws);
  assert.equal(process.env.FOO, 'from-env');
  rmSync(ws, { recursive: true });
});

test('loadSecrets is a no-op when .env is missing', () => {
  const ws = setup();
  loadSecrets(ws);
  rmSync(ws, { recursive: true });
});

test('loadSecrets requires workspaceDir (no implicit default)', () => {
  assert.throws(() => loadSecrets(), /workspaceDir is required/);
  assert.throws(() => loadSecrets(undefined), /workspaceDir is required/);
  assert.throws(() => loadSecrets(''), /workspaceDir is required/);
});

test('requireSecret throws when key missing', () => {
  delete process.env.MISSING_KEY;
  assert.throws(() => requireSecret('MISSING_KEY'), /Missing secret: MISSING_KEY/);
});

test('requireSecret returns the value when present', () => {
  process.env.PRESENT_KEY = 'value';
  assert.equal(requireSecret('PRESENT_KEY'), 'value');
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
