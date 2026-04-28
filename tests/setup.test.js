import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from '../core/scripts/setup.js';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function repo() {
  const root = mkdtempSync(join(tmpdir(), 'robin-setup-'));
  mkdirSync(join(root, 'core/skeleton'), { recursive: true });
  writeFileSync(join(root, 'core/skeleton/profile.md'), '# Profile\n');
  writeFileSync(join(root, 'core/skeleton/robin.config.json'),
    JSON.stringify({ version: '3.0.0', user: { name: '', timezone: 'UTC' }, platform: 'claude-code' }));
  return root;
}

test('setup is idempotent — does nothing if user-data/ populated', async () => {
  const root = repo();
  mkdirSync(join(root, 'user-data'));
  writeFileSync(join(root, 'user-data/profile.md'), '# Already filled\n');
  await setup(root, { ci: true });
  assert.equal(readFileSync(join(root, 'user-data/profile.md'), 'utf-8'), '# Already filled\n');
  rmSync(root, { recursive: true, force: true });
});

test('setup populates user-data/ from skeleton in CI mode', async () => {
  const root = repo();
  await setup(root, { ci: true });
  assert.ok(existsSync(join(root, 'user-data/profile.md')));
  assert.ok(existsSync(join(root, 'user-data/robin.config.json')));
  assert.ok(existsSync(join(root, 'artifacts/input')));
  assert.ok(existsSync(join(root, 'artifacts/output')));
  assert.ok(existsSync(join(root, 'backup')));
  rmSync(root, { recursive: true, force: true });
});

test('setup records baseline migration as applied', async () => {
  const root = repo();
  mkdirSync(join(root, 'core/migrations'), { recursive: true });
  writeFileSync(join(root, 'core/migrations/0001-baseline.js'),
    'export const id = "0001-baseline"; export async function up() {}');
  await setup(root, { ci: true });
  const log = JSON.parse(readFileSync(join(root, 'user-data/.migrations-applied.json'), 'utf-8'));
  assert.ok(log.find(e => e.id === '0001-baseline'));
  rmSync(root, { recursive: true, force: true });
});
