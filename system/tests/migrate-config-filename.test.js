import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { migrateConfigFilename } from '../scripts/lib/migrate-config-filename.js';

function makeTempWorkspace() {
  return mkdtempSync(path.join(tmpdir(), 'robin-test-'));
}

test('migrateConfigFilename renames arc.config.json to robin.config.json preserving content', () => {
  const ws = makeTempWorkspace();
  const oldPath = path.join(ws, 'arc.config.json');
  const newPath = path.join(ws, 'robin.config.json');
  const original = JSON.stringify({ name: 'Arc', custom: 'preserved' }, null, 2);
  writeFileSync(oldPath, original);

  const result = migrateConfigFilename(ws);

  assert.equal(result.migrated, true);
  assert.equal(existsSync(oldPath), false);
  assert.equal(existsSync(newPath), true);
  assert.equal(readFileSync(newPath, 'utf8'), original);
  rmSync(ws, { recursive: true, force: true });
});

test('migrateConfigFilename is a no-op when only robin.config.json exists', () => {
  const ws = makeTempWorkspace();
  writeFileSync(path.join(ws, 'robin.config.json'), '{}');

  const result = migrateConfigFilename(ws);

  assert.equal(result.migrated, false);
  rmSync(ws, { recursive: true, force: true });
});

test('migrateConfigFilename throws if both files exist (ambiguous state)', () => {
  const ws = makeTempWorkspace();
  writeFileSync(path.join(ws, 'arc.config.json'), '{}');
  writeFileSync(path.join(ws, 'robin.config.json'), '{}');

  assert.throws(() => migrateConfigFilename(ws), /both .* exist/i);
  rmSync(ws, { recursive: true, force: true });
});

test('migrateConfigFilename is a no-op when neither file exists', () => {
  const ws = makeTempWorkspace();

  const result = migrateConfigFilename(ws);

  assert.equal(result.migrated, false);
  rmSync(ws, { recursive: true, force: true });
});
