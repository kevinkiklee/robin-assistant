import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from '../../scripts/cli/setup.js';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function repo() {
  const root = mkdtempSync(join(tmpdir(), 'robin-setup-'));
  mkdirSync(join(root, 'system/scaffold/memory/profile'), { recursive: true });
  writeFileSync(join(root, 'system/scaffold/memory/profile/identity.md'),
    '---\ndescription: Identity\n---\n# Identity\n');
  writeFileSync(join(root, 'system/scaffold/memory/INDEX.md'),
    '# Memory Index\n');
  mkdirSync(join(root, 'system/scaffold/runtime/config'), { recursive: true });
  writeFileSync(join(root, 'system/scaffold/runtime/config/robin.config.json'),
    JSON.stringify({ version: '3.0.0', user: { name: '', timezone: 'UTC' }, platform: 'claude-code' }));
  return root;
}

test('setup is idempotent — does nothing if user-data/ populated', async () => {
  const root = repo();
  mkdirSync(join(root, 'user-data/memory/profile'), { recursive: true });
  writeFileSync(join(root, 'user-data/memory/profile/identity.md'), '# Already filled\n');
  await setup(root, { ci: true });
  assert.equal(readFileSync(join(root, 'user-data/memory/profile/identity.md'), 'utf-8'), '# Already filled\n');
  rmSync(root, { recursive: true, force: true });
});

test('setup populates user-data/ from scaffold in CI mode', async () => {
  const root = repo();
  await setup(root, { ci: true });
  assert.ok(existsSync(join(root, 'user-data/memory/profile/identity.md')));
  assert.ok(existsSync(join(root, 'user-data/memory/INDEX.md')));
  assert.ok(existsSync(join(root, 'user-data/runtime/config/robin.config.json')));
  assert.ok(existsSync(join(root, 'artifacts/input')));
  assert.ok(existsSync(join(root, 'artifacts/output')));
  assert.ok(existsSync(join(root, 'backup')));
  rmSync(root, { recursive: true, force: true });
});

test('setup records baseline migration as applied', async () => {
  const root = repo();
  mkdirSync(join(root, 'system/migrations'), { recursive: true });
  writeFileSync(join(root, 'system/migrations/0001-baseline.js'),
    'export const id = "0001-baseline"; export async function up() {}');
  await setup(root, { ci: true });
  const log = JSON.parse(readFileSync(join(root, 'user-data/runtime/state/migrations-applied.json'), 'utf-8'));
  assert.ok(log.find(e => e.id === '0001-baseline'));
  rmSync(root, { recursive: true, force: true });
});

test('setup refreshes existing user-data scripts from scaffold', async () => {
  const root = repo();
  // Existing user-data with stale script + custom (Kevin-authored) script
  mkdirSync(join(root, 'user-data/memory/profile'), { recursive: true });
  writeFileSync(join(root, 'user-data/memory/profile/identity.md'), '# Already filled\n');
  mkdirSync(join(root, 'user-data/runtime/scripts'), { recursive: true });
  writeFileSync(join(root, 'user-data/runtime/scripts/sync-gmail.js'), '// STALE: user-data/secrets/.env\n');
  writeFileSync(join(root, 'user-data/runtime/scripts/custom-script.js'), '// custom Kevin script\n');
  // Scaffold has the canonical version
  mkdirSync(join(root, 'system/scaffold/runtime/scripts'), { recursive: true });
  writeFileSync(join(root, 'system/scaffold/runtime/scripts/sync-gmail.js'), '// FRESH: user-data/runtime/secrets/.env\n');

  await setup(root, { ci: true });

  // Stale template overwritten with scaffold version
  assert.match(readFileSync(join(root, 'user-data/runtime/scripts/sync-gmail.js'), 'utf-8'), /FRESH/);
  // Kevin's custom script (no scaffold counterpart) preserved
  assert.equal(readFileSync(join(root, 'user-data/runtime/scripts/custom-script.js'), 'utf-8'), '// custom Kevin script\n');
  rmSync(root, { recursive: true, force: true });
});
