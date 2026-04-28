import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrateV3 } from '../scripts/migrate-v3.js';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURE = fileURLToPath(new URL('./fixtures/v2-workspace', import.meta.url));

function makeTarget() {
  const root = mkdtempSync(join(tmpdir(), 'robin-mv3-'));
  mkdirSync(join(root, 'system/skeleton'), { recursive: true });
  // Provide a skeleton config so migrateConfig has something to compare against
  writeFileSync(
    join(root, 'system/skeleton/robin.config.json'),
    JSON.stringify({ version: '3.0.0', user: { name: '', timezone: 'UTC' }, platform: 'claude-code' }),
  );
  mkdirSync(join(root, 'user-data'));
  return root;
}

test('migrate-v3 copies user-data files from v2 source', async () => {
  const target = makeTarget();
  await migrateV3(target, { from: FIXTURE });
  assert.ok(existsSync(join(target, 'user-data/profile.md')));
  assert.ok(existsSync(join(target, 'user-data/knowledge.md')));
  assert.ok(existsSync(join(target, 'user-data/state/sessions.md')));
  rmSync(target, { recursive: true, force: true });
});

test('migrate-v3 splits self-improvement.md, taking only user log', async () => {
  const target = makeTarget();
  await migrateV3(target, { from: FIXTURE });
  const content = readFileSync(join(target, 'user-data/self-improvement.md'), 'utf-8');
  assert.match(content, /Corrections/);
  assert.doesNotMatch(content, /Rules/); // rules half stripped
  rmSync(target, { recursive: true, force: true });
});

test('migrate-v3 refuses if target user-data/ already populated', async () => {
  const target = makeTarget();
  writeFileSync(join(target, 'user-data/profile.md'), 'EXISTING');
  await assert.rejects(migrateV3(target, { from: FIXTURE }), /not empty/i);
  rmSync(target, { recursive: true, force: true });
});

test('migrate-v3 leaves source untouched', async () => {
  const target = makeTarget();
  const beforeFiles = readdirSync(FIXTURE);
  await migrateV3(target, { from: FIXTURE });
  const afterFiles = readdirSync(FIXTURE);
  assert.deepEqual(afterFiles.sort(), beforeFiles.sort());
  rmSync(target, { recursive: true, force: true });
});
