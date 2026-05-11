import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MEMO_KIND_REGISTRY, validateMemoKind } from '../../cognition/memory/kind-registry.js';

test('reasoning.meta_schema declares D2 keys', () => {
  const schema = MEMO_KIND_REGISTRY.reasoning?.meta_schema ?? {};
  assert.equal(schema.dimension, 'string?');
  assert.equal(schema.from_signal, 'string?');
  assert.equal(schema.period, 'string?');
  assert.equal(schema.signal_count, 'number?');
  assert.equal(schema.week_starting, 'string?');
  assert.equal(schema.clusters, 'number?');
  assert.equal(schema.recall_log_ids, 'array?');
});

test('validateMemoKind accepts a D2-shaped reasoning payload', () => {
  const payload = {
    content: 'Across this week, recall about photo-tools kept surfacing a stale memo …',
    derived_by: 'meta_cognition',
    meta: {
      dimension: 'recall_failures',
      from_signal: 'meta_cognition',
      period: 'weekly',
      signal_count: 7,
      week_starting: '2026-05-04',
      clusters: 2,
      recall_log_ids: ['recall_log:abc', 'recall_log:def'],
    },
  };
  const r = validateMemoKind('reasoning', payload);
  assert.equal(r.ok, true, JSON.stringify(r));
});

test('validateMemoKind rejects wrong meta type for D2 keys', () => {
  const bad = {
    content: 'x',
    derived_by: 'meta_cognition',
    meta: { signal_count: 'seven' }, // wrong type
  };
  const r = validateMemoKind('reasoning', bad);
  assert.equal(r.ok, false);
  assert.ok(
    r.errors.some((e) => e.includes('signal_count')),
    JSON.stringify(r.errors),
  );
});
