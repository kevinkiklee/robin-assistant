import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPendingMigrations } from '../scripts/migrate.js';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function setupRepo(migrationFiles) {
  const root = mkdtempSync(join(tmpdir(), 'robin-mig-'));
  mkdirSync(join(root, 'system/migrations'), { recursive: true });
  mkdirSync(join(root, 'system/scaffold'));
  mkdirSync(join(root, 'user-data'));
  mkdirSync(join(root, 'backup'));
  writeFileSync(join(root, 'user-data/robin.config.json'), '{"version":"3.0.0"}');
  for (const [name, content] of Object.entries(migrationFiles)) {
    writeFileSync(join(root, 'system/migrations', name), content);
  }
  return root;
}

const SAMPLE_MIG = `
export const id = '0002-add-flag';
export const description = 'add user-data/flag.md';
export async function up({ workspaceDir, helpers }) {
  const { writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  writeFileSync(join(workspaceDir, 'user-data/flag.md'), 'flagged\\n');
}
`;

test('runPendingMigrations applies new migration and records it', async () => {
  const root = setupRepo({ '0002-add-flag.js': SAMPLE_MIG });
  const result = await runPendingMigrations(root);
  assert.equal(result.applied.length, 1);
  assert.equal(result.applied[0], '0002-add-flag');
  assert.ok(existsSync(join(root, 'user-data/flag.md')));
  const log = JSON.parse(readFileSync(join(root, 'user-data/.migrations-applied.json'), 'utf-8'));
  assert.equal(log.length, 1);
  assert.equal(log[0].id, '0002-add-flag');
  rmSync(root, { recursive: true, force: true });
});

test('runPendingMigrations is idempotent — no re-application', async () => {
  const root = setupRepo({ '0002-add-flag.js': SAMPLE_MIG });
  await runPendingMigrations(root);
  const r2 = await runPendingMigrations(root);
  assert.equal(r2.applied.length, 0);
  rmSync(root, { recursive: true, force: true });
});

test('runPendingMigrations --dry-run does not mutate', async () => {
  const root = setupRepo({ '0002-add-flag.js': SAMPLE_MIG });
  const result = await runPendingMigrations(root, { dryRun: true });
  assert.equal(result.would.length, 1);
  assert.ok(!existsSync(join(root, 'user-data/flag.md')));
  assert.ok(!existsSync(join(root, 'user-data/.migrations-applied.json')));
  rmSync(root, { recursive: true, force: true });
});
