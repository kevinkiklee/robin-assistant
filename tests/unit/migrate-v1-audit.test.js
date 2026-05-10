import assert from 'node:assert';
import { test } from 'node:test';
import { buildFromV1, sourceHash } from '../../src/migrate-v1/audit.js';

test('sourceHash is deterministic + uses v1: prefix', () => {
  const a = sourceHash('capture:abc123');
  const b = sourceHash('capture:abc123');
  assert.equal(a, b);
  assert.equal(a.length, 64);
  assert.notEqual(sourceHash('capture:xyz'), a);
});

test('buildFromV1 produces canonical shape', () => {
  const out = buildFromV1({
    v1_table: 'capture',
    v1_id: 'capture:abc123',
    migrated_at: '2026-05-12T00:00:00Z',
  });
  assert.equal(out.v1_table, 'capture');
  assert.equal(out.v1_id, 'capture:abc123');
  assert.equal(out.source_hash, sourceHash('capture:abc123'));
  assert.equal(out.migrated_at, '2026-05-12T00:00:00Z');
});

test('buildFromV1 defaults migrated_at to current ISO', () => {
  const before = new Date().toISOString();
  const out = buildFromV1({ v1_table: 'entity', v1_id: 'entity:e1' });
  const after = new Date().toISOString();
  assert.ok(out.migrated_at >= before && out.migrated_at <= after);
});
