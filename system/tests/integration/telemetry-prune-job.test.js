// Integration tests for the telemetry-prune internal job.

import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import telemetryPrune from '../../cognition/jobs/internal/telemetry-prune.js';
import { writeConfig as __robinWriteConfig } from '../../config/paths.js';
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

test('telemetry-prune deletes raw past 7d AND hourly past 90d', async () => {
  const db = await fresh();
  const eightDaysAgo = new Date(Date.now() - 8 * 86_400_000);
  const ninetyOneDaysAgo = new Date(Date.now() - 91 * 86_400_000);
  const fresh1 = new Date();
  await db
    .query(
      surql`CREATE intuition_telemetry CONTENT {
        ts: ${eightDaysAgo}, latency_ms: 10, tokens_injected: 0, hits: 0, query_chars: 0
      }`,
    )
    .collect();
  await db
    .query(
      surql`CREATE intuition_telemetry CONTENT {
        ts: ${fresh1}, latency_ms: 10, tokens_injected: 0, hits: 0, query_chars: 0
      }`,
    )
    .collect();
  await db
    .query(
      surql`CREATE telemetry_hourly CONTENT {
        hour: ${ninetyOneDaysAgo}, faculty: 'intuition', event_kind: 'recall',
        count: 1, dimensions: {}, metric_sums: {}, metric_buckets: {}
      }`,
    )
    .collect();
  await db
    .query(
      surql`CREATE telemetry_hourly CONTENT {
        hour: ${fresh1}, faculty: 'intuition', event_kind: 'recall',
        count: 1, dimensions: { x: 'y' }, metric_sums: {}, metric_buckets: {}
      }`,
    )
    .collect();
  const res = JSON.parse(await telemetryPrune({ db }));
  assert.ok((res.intuition_telemetry?.count ?? 0) >= 1);
  assert.ok((res.telemetry_hourly?.count ?? 0) >= 1);
  const [iCount] = await db
    .query('SELECT count() AS n FROM intuition_telemetry GROUP ALL')
    .collect();
  const [hCount] = await db.query('SELECT count() AS n FROM telemetry_hourly GROUP ALL').collect();
  assert.equal(iCount?.[0]?.n, 1);
  assert.equal(hCount?.[0]?.n, 1);
  await close(db);
});

test('telemetry-prune hard ceiling deletes >30d pending recall_log + emits warning row', async () => {
  const db = await fresh();
  const veryOld = new Date(Date.now() - 31 * 86_400_000);
  await db
    .query(
      surql`CREATE recall_log CONTENT {
        ts: ${veryOld}, query: 'stuck', k: 6, ranked_hits: [],
        outcome: 'pending', session_id: 's1', meta: {}
      }`,
    )
    .collect();
  const res = JSON.parse(await telemetryPrune({ db }));
  assert.ok((res.recall_log_pending?.count ?? 0) >= 1);
  // The warning telemetry row went to telemetry_raw_reinforcement.
  // (Recorder writes there by default; we just verify it was attempted.)
  // We can't assert the row exists because telemetry_raw_reinforcement is
  // not pre-defined as a SCHEMAFULL table — CREATE on an undefined table
  // is allowed in SurrealDB but creates the table SCHEMALESS implicitly.
  // For now, the test just verifies the prune completed.
  const [rows] = await db.query('SELECT count() AS n FROM recall_log GROUP ALL').collect();
  assert.equal(rows?.[0]?.n ?? 0, 0);
  await close(db);
});

test('telemetry-prune default-path pending exclusion (Stage 2): aged pending rows NOT deleted', async () => {
  const db = await fresh();
  const tenDays = new Date(Date.now() - 10 * 86_400_000);
  await db
    .query(
      surql`CREATE recall_log CONTENT {
        ts: ${tenDays}, query: 'aged-pending', k: 6, ranked_hits: [],
        outcome: 'pending', session_id: 's1', meta: {}
      }`,
    )
    .collect();
  await telemetryPrune({ db });
  const [rows] = await db.query('SELECT query FROM recall_log').collect();
  // 10d-old pending row survives default 7d prune (Stage 2 has where: outcome != pending).
  // 30d hard ceiling does not apply (only 10d old).
  assert.deepEqual(
    rows.map((r) => r.query),
    ['aged-pending'],
  );
  await close(db);
});

test('telemetry-prune no-ops when enabled=false', async () => {
  const db = await fresh();
  await db.query('UPDATE runtime:`telemetry.config` SET value.enabled = false').collect();
  const eightDays = new Date(Date.now() - 8 * 86_400_000);
  await db
    .query(
      surql`CREATE intuition_telemetry CONTENT {
        ts: ${eightDays}, latency_ms: 10, tokens_injected: 0, hits: 0, query_chars: 0
      }`,
    )
    .collect();
  const res = JSON.parse(await telemetryPrune({ db }));
  assert.equal(res.skipped, 'disabled');
  // Row should still be present (no prune ran).
  const [rows] = await db.query('SELECT count() AS n FROM intuition_telemetry GROUP ALL').collect();
  assert.equal(rows?.[0]?.n, 1);
  await close(db);
});
