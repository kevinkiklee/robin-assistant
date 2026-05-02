import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHelpers } from '../../scripts/migrate/lib/migration-helpers.js';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function repo() {
  const root = mkdtempSync(join(tmpdir(), 'robin-mh-'));
  mkdirSync(join(root, 'user-data/runtime/config'), { recursive: true });
  mkdirSync(join(root, 'system/scaffold'), { recursive: true });
  return root;
}

test('renameFile moves user-data file', async () => {
  const root = repo();
  writeFileSync(join(root, 'user-data/old.md'), 'x');
  const helpers = createHelpers(root);
  await helpers.renameFile('old.md', 'new.md');
  assert.ok(existsSync(join(root, 'user-data/new.md')));
  assert.ok(!existsSync(join(root, 'user-data/old.md')));
  rmSync(root, { recursive: true, force: true });
});

test('renameFile is idempotent — no-op when source missing', async () => {
  const root = repo();
  const helpers = createHelpers(root);
  await helpers.renameFile('absent.md', 'still-absent.md'); // should not throw
  rmSync(root, { recursive: true, force: true });
});

test('addFileFromScaffold copies scaffold file when missing', async () => {
  const root = repo();
  writeFileSync(join(root, 'system/scaffold/health.md'), '# Health\n');
  const helpers = createHelpers(root);
  await helpers.addFileFromScaffold('health.md');
  assert.equal(readFileSync(join(root, 'user-data/health.md'), 'utf-8'), '# Health\n');
  rmSync(root, { recursive: true, force: true });
});

test('addConfigField adds nested key with default', async () => {
  const root = repo();
  writeFileSync(join(root, 'user-data/runtime/config/robin.config.json'), JSON.stringify({ user: { name: 'T' } }));
  const helpers = createHelpers(root);
  await helpers.addConfigField('memory.maxItems', 1000);
  const cfg = JSON.parse(readFileSync(join(root, 'user-data/runtime/config/robin.config.json'), 'utf-8'));
  assert.equal(cfg.memory.maxItems, 1000);
  rmSync(root, { recursive: true, force: true });
});

test('renameConfigField moves nested value', async () => {
  const root = repo();
  writeFileSync(join(root, 'user-data/runtime/config/robin.config.json'),
    JSON.stringify({ memory: { knowledgeFile: 'knowledge.md' } }));
  const helpers = createHelpers(root);
  await helpers.renameConfigField('memory.knowledgeFile', 'memory.referenceFile');
  const cfg = JSON.parse(readFileSync(join(root, 'user-data/runtime/config/robin.config.json'), 'utf-8'));
  assert.equal(cfg.memory.referenceFile, 'knowledge.md');
  assert.equal(cfg.memory.knowledgeFile, undefined);
  rmSync(root, { recursive: true, force: true });
});
