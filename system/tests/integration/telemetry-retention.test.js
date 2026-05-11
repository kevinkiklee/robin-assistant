// Integration tests for pruneRawTelemetry — table-aware DELETE with
// optional timestampField + where clauses.

import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { writeConfig as __robinWriteConfig } from '../../config/paths.js';
import { pruneRawTelemetry } from '../../cognition/telemetry/retention.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';

const __robinTestHome = __robinJoin(
  __robinTmpdir(),
  `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
);
__robinMkdirSync(__robinTestHome, { recursive: true });
process.env.ROBIN_HOME = __robinTestHome;
await __robinWriteConfig({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  const dir = resolve(import.meta.dirname, '../../data/db/migrations');
  await runMigrations(db, dir);
  return db;
}

test('prune respects timestampField: telemetry_hourly uses hour; intuition_telemetry uses ts', async () => {
  const db = await fresh();
  const old = new Date('2026-01-01T00:00:00Z');
  const recent = new Date('2026-05-11T14:00:00Z');
  await db
    .query(
      surql`CREATE telemetry_hourly CONTENT {
        hour: ${old}, faculty: 'intuition', event_kind: 'recall',
        count: 1, dimensions: { src: 'old' }, metric_sums: {}, metric_buckets: {}
      }`,
    )
    .collect();
  await db
    .query(
      surql`CREATE telemetry_hourly CONTENT {
        hour: ${recent}, faculty: 'intuition', event_kind: 'recall',
        count: 1, dimensions: { src: 'new' }, metric_sums: {}, metric_buckets: {}
      }`,
    )
    .collect();
  await db
    .query(
      surql`CREATE intuition_telemetry CONTENT {
        ts: ${old}, latency_ms: 10, tokens_injected: 0, hits: 0, query_chars: 0
      }`,
    )
    .collect();
  await db
    .query(
      surql`CREATE intuition_telemetry CONTENT {
        ts: ${recent}, latency_ms: 10, tokens_injected: 0, hits: 0, query_chars: 0
      }`,
    )
    .collect();

  const cutoff = new Date('2026-04-01T00:00:00Z');
  await pruneRawTelemetry({
    db,
    table: 'telemetry_hourly',
    before: cutoff,
    timestampField: 'hour',
  });
  await pruneRawTelemetry({ db, table: 'intuition_telemetry', before: cutoff });

  const [a] = await db
    .query('SELECT count() AS n FROM telemetry_hourly GROUP ALL')
    .collect();
  const [b] = await db
    .query('SELECT count() AS n FROM intuition_telemetry GROUP ALL')
    .collect();
  assert.equal(a?.[0]?.n, 1);
  assert.equal(b?.[0]?.n, 1);
  await close(db);
});

test('prune respects where: recall_log pending rows are not deleted by default 7d prune', async () => {
  const db = await fresh();
  const old = new Date('2026-04-01T00:00:00Z');
  const recent = new Date('2026-05-11T14:00:00Z');
  await db
    .query(
      surql`CREATE recall_log CONTENT {
        ts: ${old}, query: 'old-pending', k: 6, ranked_hits: [],
        outcome: 'pending', session_id: 's1', meta: {}
      }`,
    )
    .collect();
  await db
    .query(
      surql`CREATE recall_log CONTENT {
        ts: ${old}, query: 'old-reinforced', k: 6, ranked_hits: [],
        outcome: 'reinforced', session_id: 's2', meta: {},
        evaluated_at: ${old}
      }`,
    )
    .collect();
  await db
    .query(
      surql`CREATE recall_log CONTENT {
        ts: ${recent}, query: 'new-pending', k: 6, ranked_hits: [],
        outcome: 'pending', session_id: 's3', meta: {}
      }`,
    )
    .collect();

  const cutoff = new Date('2026-05-04T00:00:00Z'); // 7d before recent
  const result = await pruneRawTelemetry({
    db,
    table: 'recall_log',
    before: cutoff,
    where: 'outcome != "pending"',
  });
  assert.equal(result.count, 1, 'should have deleted exactly old-reinforced');

  const [rows] = await db.query('SELECT query FROM recall_log').collect();
  const qs = rows.map((r) => r.query).sort();
  // old-pending KEPT (pending exclusion); new-pending KEPT (fresh); old-reinforced deleted.
  assert.deepEqual(qs, ['new-pending', 'old-pending']);
  await close(db);
});

test('pending hard ceiling: outcome=pending AND old → deleted with explicit where clause', async () => {
  const db = await fresh();
  const veryOld = new Date('2026-03-01T00:00:00Z');
  await db
    .query(
      surql`CREATE recall_log CONTENT {
        ts: ${veryOld}, query: 'stuck', k: 6, ranked_hits: [],
        outcome: 'pending', session_id: 's1', meta: {}
      }`,
    )
    .collect();
  // > 30d after veryOld
  const cutoff = new Date('2026-04-15T00:00:00Z');
  const out = await pruneRawTelemetry({
    db,
    table: 'recall_log',
    before: cutoff,
    where: 'outcome = "pending"',
  });
  assert.equal(out.count, 1);
  const [rows] = await db
    .query('SELECT count() AS n FROM recall_log GROUP ALL')
    .collect();
  assert.equal(rows?.[0]?.n ?? 0, 0);
  await close(db);
});

test('prune with no rows matching returns count=0', async () => {
  const db = await fresh();
  const cutoff = new Date('2020-01-01T00:00:00Z');
  const out = await pruneRawTelemetry({
    db,
    table: 'intuition_telemetry',
    before: cutoff,
  });
  assert.equal(out.count, 0);
  await close(db);
});
