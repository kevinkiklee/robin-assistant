// Unit tests for recordTelemetry — dimension validation, fan-out, and the
// §3.1 / §3.4 / §3.5 contract from the C3 telemetry umbrella spec.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recordTelemetry } from '../../cognition/telemetry/recorder.js';

function stubDb() {
  const writes = [];
  return {
    writes,
    query: (q, params) => ({
      collect: async () => {
        writes.push({ q: String(q), params });
        return [[]];
      },
    }),
  };
}

test('recordTelemetry rejects dimension value > 64 chars', async () => {
  const db = stubDb();
  await assert.rejects(
    recordTelemetry({
      db,
      faculty: 'intuition',
      event_kind: 'recall',
      dimensions: { source: 'a'.repeat(65) },
      metrics: {},
    }),
    /dimension value exceeds 64 chars/,
  );
  assert.equal(db.writes.length, 0);
});

test('recordTelemetry rejects dimension value with disallowed chars (space)', async () => {
  const db = stubDb();
  await assert.rejects(
    recordTelemetry({
      db,
      faculty: 'intuition',
      event_kind: 'recall',
      dimensions: { mode: 'has spaces' },
    }),
    /dimension value charset/,
  );
});

test('recordTelemetry accepts a normal dimension value', async () => {
  const db = stubDb();
  await recordTelemetry({
    db,
    faculty: 'intuition',
    event_kind: 'recall',
    dimensions: { kind: 'normal_value-1.0' },
    metrics: {},
  });
  assert.equal(db.writes.length, 1);
});

test('recordTelemetry rejects float dimension values', async () => {
  const db = stubDb();
  await assert.rejects(
    recordTelemetry({
      db,
      faculty: 'x',
      event_kind: 'y',
      dimensions: { a: 1.5 },
    }),
    /dimension value type/,
  );
});

test('recordTelemetry rejects nested-object dimension values', async () => {
  const db = stubDb();
  await assert.rejects(
    recordTelemetry({
      db,
      faculty: 'x',
      event_kind: 'y',
      dimensions: { a: { nested: 1 } },
    }),
    /dimension value type/,
  );
});

test('recordTelemetry rejects non-ASCII dimension values (charset)', async () => {
  const db = stubDb();
  await assert.rejects(
    recordTelemetry({
      db,
      faculty: 'x',
      event_kind: 'y',
      dimensions: { a: 'café' },
    }),
    /dimension value charset/,
  );
});

test('recordTelemetry rejects free-text query in dimensions (callers must use meta)', async () => {
  const db = stubDb();
  await assert.rejects(
    recordTelemetry({
      db,
      faculty: 'belief',
      event_kind: 'call',
      dimensions: { query: 'how do I bake a sourdough loaf?' },
    }),
    /dimension value charset|exceeds 64 chars/,
  );
  // Valid usage: put it in meta.
  await recordTelemetry({
    db,
    faculty: 'belief',
    event_kind: 'call',
    dimensions: {},
    meta: { query: 'how do I bake a sourdough loaf?' },
  });
  assert.equal(db.writes.length, 1);
});

test('recordTelemetry accepts bool and int dimension values', async () => {
  const db = stubDb();
  await recordTelemetry({
    db,
    faculty: 'intuition',
    event_kind: 'recall',
    dimensions: { focus_block_present: true, hit_count: 4 },
    metrics: {},
  });
  assert.equal(db.writes.length, 1);
  const payload = db.writes[0].params;
  assert.equal(payload.dimensions.focus_block_present, true);
  assert.equal(payload.dimensions.hit_count, 4);
});

test('recordTelemetry fans out object-shaped metrics into scalar entries', async () => {
  const db = stubDb();
  await recordTelemetry({
    db,
    faculty: 'intuition',
    event_kind: 'recall',
    dimensions: { source: 'intuition' },
    metrics: {
      latency_ms: 18,
      contradictions_suppressed_by_rule: { low_confidence: 3, private_redaction: 1 },
    },
  });
  const payload = db.writes[0].params;
  assert.equal(payload.metrics.latency_ms, 18);
  assert.equal(payload.metrics.contradictions_suppressed_low_confidence, 3);
  assert.equal(payload.metrics.contradictions_suppressed_private_redaction, 1);
  assert.equal(payload.metrics.contradictions_suppressed_by_rule, undefined);
});

test('recordTelemetry rejects object-shaped metrics with > 16 keys', async () => {
  const db = stubDb();
  const big = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`rule_${i}`, i]));
  await assert.rejects(
    recordTelemetry({
      db,
      faculty: 'intuition',
      event_kind: 'recall',
      dimensions: {},
      metrics: { contradictions_suppressed_by_rule: big },
    }),
    /object-shaped metric exceeds 16 keys/,
  );
});

test('recordTelemetry accepts object-shaped metrics with exactly 16 keys', async () => {
  const db = stubDb();
  const ok = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`rule_${i}`, i]));
  await recordTelemetry({
    db,
    faculty: 'intuition',
    event_kind: 'recall',
    dimensions: {},
    metrics: { contradictions_suppressed_by_rule: ok },
  });
  assert.equal(db.writes.length, 1);
  const payload = db.writes[0].params;
  assert.equal(payload.metrics.contradictions_suppressed_rule_15, 15);
});

test('recordTelemetry routes the payload to telemetry_raw_<faculty> by default', async () => {
  const db = stubDb();
  await recordTelemetry({
    db,
    faculty: 'intuition',
    event_kind: 'recall',
    dimensions: {},
    metrics: {},
  });
  assert.match(db.writes[0].q, /CREATE telemetry_raw_intuition CONTENT/);
});

test('recordTelemetry honours targetTable override', async () => {
  const db = stubDb();
  await recordTelemetry({
    db,
    faculty: 'reinforcement',
    event_kind: 'pending_recall_log_force_pruned',
    dimensions: {},
    metrics: { count: 3 },
    targetTable: 'telemetry_raw_reinforcement',
  });
  assert.match(db.writes[0].q, /CREATE telemetry_raw_reinforcement CONTENT/);
});

test('recordTelemetry requires faculty + event_kind', async () => {
  const db = stubDb();
  await assert.rejects(recordTelemetry({ db, event_kind: 'recall' }), /faculty required/);
  await assert.rejects(recordTelemetry({ db, faculty: 'intuition' }), /event_kind required/);
});
