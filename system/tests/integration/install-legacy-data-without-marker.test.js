import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { discoverExistingHomes } from '../../src/runtime/data-store.js';

test('discoverExistingHomes finds a legacy v2 layout (db/CURRENT) without marker', () => {
  const dir = mkdtempSync(join(tmpdir(), 'robin-legacy-'));
  mkdirSync(join(dir, 'db'), { recursive: true });
  writeFileSync(join(dir, 'db', 'CURRENT'), 'rocksdb');
  try {
    const result = discoverExistingHomes({ candidates: [dir] });
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].kind, 'legacy');
    assert.strictEqual(result[0].path, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('discoverExistingHomes finds a legacy v2 layout (secrets/.env) without marker', () => {
  const dir = mkdtempSync(join(tmpdir(), 'robin-legacy-'));
  mkdirSync(join(dir, 'secrets'), { recursive: true });
  writeFileSync(join(dir, 'secrets', '.env'), 'X=y', { mode: 0o600 });
  try {
    const result = discoverExistingHomes({ candidates: [dir] });
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].kind, 'legacy');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
