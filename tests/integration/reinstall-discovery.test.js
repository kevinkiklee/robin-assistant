import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { discoverExistingHomes } from '../../src/runtime/data-store.js';

test('discovery finds multiple candidates when both home locations have layouts', () => {
  const a = mkdtempSync(join(tmpdir(), 'robin-a-'));
  const b = mkdtempSync(join(tmpdir(), 'robin-b-'));
  writeFileSync(join(a, '.robin-data'), JSON.stringify({ version: 1, createdAt: 'x' }));
  mkdirSync(join(b, 'db'), { recursive: true });
  writeFileSync(join(b, 'db', 'CURRENT'), 'rocksdb');
  try {
    const result = discoverExistingHomes({ candidates: [a, b] });
    assert.strictEqual(result.length, 2);
    const kinds = result.map((r) => r.kind).sort();
    assert.deepStrictEqual(kinds, ['legacy', 'marker']);
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});
