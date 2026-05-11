// Backwards-compat sweep (§9.3): confirms that the rollup is purely
// additive — existing recall_log / intuition_telemetry consumers
// continue to read raw rows; B1 attribution.mode, A3 mmr_path,
// D1 focus_block_present, D3 query-in-meta all propagate correctly.

import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { writeConfig as __robinWriteConfig } from '../../config/paths.js';
import { readTelemetryConfig } from '../../cognition/telemetry/config.js';
import { rollupHotTelemetry } from '../../cognition/telemetry/rollup.js';
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

test('B1 attribution.mode counts propagate: 5 citation + 3 fallback_no_reply → telemetry_hourly', async () => {
  const db = await fresh();
  const hour = new Date('2026-05-11T14:00:00Z');
  const evaluated = new Date(hour.getTime() + 6 * 60_000);
  for (let i = 0; i < 5; i++) {
    await db
      .query(
        surql`CREATE recall_log CONTENT {
          ts: ${hour}, evaluated_at: ${evaluated},
          query: ${`q${i}`}, k: 6, ranked_hits: [], outcome: 'reinforced',
          session_id: ${`s${i}`},
          attribution: { mode: 'citation', used_count: 1, total: 2, dropped_hits: 0, elapsed_ms: 5 },
          meta: { from: 'intuition' }
        }`,
      )
      .collect();
  }
  for (let i = 0; i < 3; i++) {
    await db
      .query(
        surql`CREATE recall_log CONTENT {
          ts: ${hour}, evaluated_at: ${evaluated},
          query: ${`qf${i}`}, k: 6, ranked_hits: [], outcome: 'reinforced',
          session_id: ${`sf${i}`},
          attribution: { mode: 'fallback_no_reply', used_count: 0, total: 0, dropped_hits: 0, elapsed_ms: 5 },
          meta: { from: 'intuition' }
        }`,
      )
      .collect();
  }
  const cfg = await readTelemetryConfig(db);
  await rollupHotTelemetry({
    db,
    cfg,
    nowFn: () => new Date(hour.getTime() + 65 * 60_000),
  });
  const [cite] = await db
    .query(
      `SELECT count FROM telemetry_hourly
        WHERE faculty='intuition' AND event_kind='recall_attribution'
          AND dimensions.mode='citation'`,
    )
    .collect();
  const [fb] = await db
    .query(
      `SELECT count FROM telemetry_hourly
        WHERE faculty='intuition' AND event_kind='recall_attribution'
          AND dimensions.mode='fallback_no_reply'`,
    )
    .collect();
  assert.equal(cite?.[0]?.count, 5);
  assert.equal(fb?.[0]?.count, 3);
  await close(db);
});

test('A3 mmr_path dimension propagates: 4 cosine + 2 substring → two rollup rows', async () => {
  const db = await fresh();
  const hour = new Date('2026-05-11T14:00:00Z');
  for (let i = 0; i < 4; i++) {
    await db
      .query(
        surql`CREATE intuition_telemetry CONTENT {
          ts: ${hour}, latency_ms: 10, tokens_injected: 0, hits: 0, query_chars: 0,
          meta: { from: 'intuition', mmr_path: 'cosine' }
        }`,
      )
      .collect();
  }
  for (let i = 0; i < 2; i++) {
    await db
      .query(
        surql`CREATE intuition_telemetry CONTENT {
          ts: ${hour}, latency_ms: 10, tokens_injected: 0, hits: 0, query_chars: 0,
          meta: { from: 'intuition', mmr_path: 'substring' }
        }`,
      )
      .collect();
  }
  const cfg = await readTelemetryConfig(db);
  await rollupHotTelemetry({
    db,
    cfg,
    nowFn: () => new Date(hour.getTime() + 65 * 60_000),
  });
  const [rows] = await db
    .query(
      `SELECT dimensions, count FROM telemetry_hourly
        WHERE faculty='intuition' AND event_kind='recall'`,
    )
    .collect();
  assert.equal(rows.length, 2);
  const cosine = rows.find((r) => r.dimensions.mmr_path === 'cosine');
  const substring = rows.find((r) => r.dimensions.mmr_path === 'substring');
  assert.equal(cosine.count, 4);
  assert.equal(substring.count, 2);
  await close(db);
});

test('D1 focus_block_present dimension propagates: 3 true + 5 false → two rows', async () => {
  const db = await fresh();
  const hour = new Date('2026-05-11T14:00:00Z');
  const evaluated = new Date(hour.getTime() + 6 * 60_000);
  for (let i = 0; i < 3; i++) {
    await db
      .query(
        surql`CREATE recall_log CONTENT {
          ts: ${hour}, evaluated_at: ${evaluated},
          query: ${`q${i}`}, k: 6, ranked_hits: [], outcome: 'reinforced',
          session_id: ${`s${i}`},
          attribution: { mode: 'citation', used_count: 1, total: 1, dropped_hits: 0, elapsed_ms: 5 },
          meta: { from: 'intuition', focus_block_present: true, focus_block_tokens: 200 }
        }`,
      )
      .collect();
  }
  for (let i = 0; i < 5; i++) {
    await db
      .query(
        surql`CREATE recall_log CONTENT {
          ts: ${hour}, evaluated_at: ${evaluated},
          query: ${`qf${i}`}, k: 6, ranked_hits: [], outcome: 'reinforced',
          session_id: ${`sf${i}`},
          attribution: { mode: 'citation', used_count: 1, total: 1, dropped_hits: 0, elapsed_ms: 5 },
          meta: { from: 'intuition', focus_block_present: false, focus_block_tokens: 0 }
        }`,
      )
      .collect();
  }
  const cfg = await readTelemetryConfig(db);
  await rollupHotTelemetry({
    db,
    cfg,
    nowFn: () => new Date(hour.getTime() + 65 * 60_000),
  });
  const [rows] = await db
    .query(
      `SELECT dimensions.focus_block_present AS fb, count FROM telemetry_hourly
        WHERE faculty='intuition' AND event_kind='recall_attribution'
        ORDER BY fb`,
    )
    .collect();
  assert.equal(rows.length, 2);
  const truthy = rows.find((r) => r.fb === true);
  const falsy = rows.find((r) => r.fb === false);
  assert.equal(truthy.count, 3);
  assert.equal(falsy.count, 5);
  await close(db);
});

test('D3 query handling: cadence belief.call rollup dimensions do not include query (D3 schema pending)', async () => {
  // D3 will eventually add `meta` to cadence_telemetry with a free-text
  // `query` field. C3's bridge contract is: dimensions are limited to
  // {success: bool}; any free text MUST stay on the raw row. Today,
  // cadence_telemetry is SCHEMAFULL without `meta`, so we just verify
  // the bridge SELECT does not emit query as a dimension.
  const db = await fresh();
  const hour = new Date('2026-05-11T14:00:00Z');
  await db
    .query(
      surql`CREATE cadence_telemetry CONTENT {
        ts: ${hour}, step: 'belief.call', success: true, duration_ms: 30,
        tokens_in: 200, tokens_out: 40
      }`,
    )
    .collect();
  const cfg = await readTelemetryConfig(db);
  await rollupHotTelemetry({
    db,
    cfg,
    nowFn: () => new Date(hour.getTime() + 65 * 60_000),
  });
  const [rows] = await db
    .query(
      "SELECT dimensions FROM telemetry_hourly WHERE faculty='belief' AND event_kind='call'",
    )
    .collect();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].dimensions.query, undefined);
  // The only dimension key in this round is `success` — bridge SELECT
  // GROUP BY hour, step, success.
  assert.equal(rows[0].dimensions.success, true);
  await close(db);
});

test('hand-aggregated raw == rollup ±1 row on a chosen 1-hour window', async () => {
  const db = await fresh();
  const hour = new Date('2026-05-11T14:00:00Z');
  for (let i = 0; i < 7; i++) {
    await db
      .query(
        surql`CREATE intuition_telemetry CONTENT {
          ts: ${new Date(hour.getTime() + i * 60_000)},
          latency_ms: ${10 + i}, tokens_injected: 100, hits: 1, query_chars: 50,
          meta: { from: 'intuition', mmr_path: 'cosine' }
        }`,
      )
      .collect();
  }
  const cfg = await readTelemetryConfig(db);
  await rollupHotTelemetry({
    db,
    cfg,
    nowFn: () => new Date(hour.getTime() + 65 * 60_000),
  });
  const [rolled] = await db
    .query(
      `SELECT count, metric_sums.latency_ms_sum AS lsum FROM telemetry_hourly
        WHERE faculty='intuition' AND event_kind='recall'`,
    )
    .collect();
  const hourEnd = new Date(hour.getTime() + 3_600_000);
  const [hand] = await db
    .query(
      surql`SELECT count() AS n, math::sum(latency_ms) AS lsum
            FROM intuition_telemetry
            WHERE ts >= ${hour} AND ts < ${hourEnd}
            GROUP ALL`,
    )
    .collect();
  assert.ok(Math.abs(rolled[0].count - hand[0].n) <= 1);
  assert.ok(Math.abs(rolled[0].lsum - hand[0].lsum) <= 1);
  await close(db);
});

test('rollup does not modify recall_log (read-only against raw)', async () => {
  const db = await fresh();
  const hour = new Date('2026-05-11T14:00:00Z');
  const evaluated = new Date(hour.getTime() + 6 * 60_000);
  await db
    .query(
      surql`CREATE recall_log SET
        ts = ${hour}, evaluated_at = ${evaluated},
        query = 'sourdough', k = 6, ranked_hits = [], outcome = 'reinforced',
        session_id = 's1',
        attribution = { mode: 'citation', used_count: 1, total: 1, dropped_hits: 0, elapsed_ms: 5 },
        meta = { from: 'intuition' }
      `,
    )
    .collect();
  const cfg = await readTelemetryConfig(db);
  await rollupHotTelemetry({
    db,
    cfg,
    nowFn: () => new Date(hour.getTime() + 65 * 60_000),
  });
  const [rows] = await db
    .query('SELECT query, outcome FROM recall_log')
    .collect();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].query, 'sourdough');
  assert.equal(rows[0].outcome, 'reinforced');
  await close(db);
});

test('B2 fan-out: per-rule contradictions_suppressed_* scalars survive on the raw row', async () => {
  // Until B2 lands, the inject.js writer doesn't actually fan out — but
  // the C3 contract says: if a faculty writes pre-fanned-out scalars onto
  // meta.* (per spec §3.4), they are preserved on the raw row. The rollup
  // SELECT does not currently aggregate them (open question §11.2), so we
  // verify only the raw-row preservation here. When B2 ships, this test
  // can be extended to assert metric_sums.contradictions_suppressed_*_sum.
  const db = await fresh();
  const hour = new Date('2026-05-11T14:00:00Z');
  await db
    .query(
      surql`CREATE intuition_telemetry CONTENT {
        ts: ${hour}, latency_ms: 10, tokens_injected: 0, hits: 0, query_chars: 0,
        meta: { from: 'intuition', mmr_path: 'cosine',
          contradictions_suppressed_low_confidence: 2,
          contradictions_suppressed_private_redaction: 1 }
      }`,
    )
    .collect();
  const [raw] = await db.query('SELECT meta FROM intuition_telemetry').collect();
  assert.equal(raw[0].meta.contradictions_suppressed_low_confidence, 2);
  assert.equal(raw[0].meta.contradictions_suppressed_private_redaction, 1);
  await close(db);
});
