import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrateConfig } from '../core/scripts/lib/config-migrate.js';
import { writeFileSync, readFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function setup({ user, skeleton }) {
  const root = mkdtempSync(join(tmpdir(), 'robin-cfgmig-'));
  mkdirSync(join(root, 'core/skeleton'), { recursive: true });
  mkdirSync(join(root, 'user-data'));
  writeFileSync(join(root, 'core/skeleton/robin.config.json'), JSON.stringify(skeleton));
  writeFileSync(join(root, 'user-data/robin.config.json'), JSON.stringify(user));
  return root;
}

test('config-migrate adds missing top-level field with default', async () => {
  const root = setup({
    user: { version: '3.0.0', user: { name: 'T' } },
    skeleton: { version: '3.0.0', user: { name: '' }, dream: { frequency: 'daily' } },
  });
  const result = await migrateConfig(root);
  assert.equal(result.added.length, 1);
  assert.equal(result.added[0], 'dream');
  const out = JSON.parse(readFileSync(join(root, 'user-data/robin.config.json'), 'utf-8'));
  assert.deepEqual(out.dream, { frequency: 'daily' });
  rmSync(root, { recursive: true, force: true });
});

test('config-migrate is idempotent (no changes when up-to-date)', async () => {
  const cfg = { version: '3.0.0', user: { name: 'T' }, dream: { frequency: 'daily' } };
  const root = setup({ user: cfg, skeleton: cfg });
  const result = await migrateConfig(root);
  assert.equal(result.added.length, 0);
  rmSync(root, { recursive: true, force: true });
});

test('config-migrate warns on removed fields', async () => {
  const root = setup({
    user: { version: '3.0.0', user: { name: 'T' }, oldField: 'gone' },
    skeleton: { version: '3.0.0', user: { name: '' } },
  });
  const result = await migrateConfig(root);
  assert.deepEqual(result.removed, ['oldField']);
  rmSync(root, { recursive: true, force: true });
});
