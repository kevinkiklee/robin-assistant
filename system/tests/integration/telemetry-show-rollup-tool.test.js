// Integration tests for the show_telemetry_rollup MCP tool.

import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { writeConfig as __robinWriteConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createShowTelemetryRollupTool } from '../../io/mcp/tools/show-telemetry-rollup.js';

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

function payload(out) {
  return JSON.parse(out.content?.[0]?.text ?? '{}');
}

test('show_telemetry_rollup returns shadow-mode error when shadow_mode=true', async () => {
  const db = await fresh();
  const tool = createShowTelemetryRollupTool({ db });
  const out = await tool.handler({});
  const p = payload(out);
  assert.match(p.error ?? '', /shadow mode/);
  await close(db);
});

test('show_telemetry_rollup default window (PT24H) returns recent rows', async () => {
  const db = await fresh();
  await db.query('UPDATE runtime:`telemetry.config` SET value.shadow_mode = false').collect();
  const now = new Date();
  await db
    .query(
      surql`CREATE telemetry_hourly CONTENT {
        hour: ${now}, faculty: 'intuition', event_kind: 'recall',
        count: 5, dimensions: { source: 'intuition' },
        metric_sums: { latency_ms_sum: 100 }, metric_buckets: {}
      }`,
    )
    .collect();
  const tool = createShowTelemetryRollupTool({ db });
  const out = await tool.handler({});
  const p = payload(out);
  assert.ok(Array.isArray(p.rows));
  assert.ok(p.rows.length >= 1);
  assert.equal(p.rows[0].faculty, 'intuition');
  await close(db);
});

test('show_telemetry_rollup filters by faculty', async () => {
  const db = await fresh();
  await db.query('UPDATE runtime:`telemetry.config` SET value.shadow_mode = false').collect();
  const now = new Date();
  await db
    .query(
      surql`CREATE telemetry_hourly CONTENT {
        hour: ${now}, faculty: 'intuition', event_kind: 'recall',
        count: 5, dimensions: {}, metric_sums: {}, metric_buckets: {}
      }`,
    )
    .collect();
  await db
    .query(
      surql`CREATE telemetry_hourly CONTENT {
        hour: ${now}, faculty: 'reinforcement', event_kind: 'evaluate',
        count: 3, dimensions: { outcome: 'reinforced' }, metric_sums: {}, metric_buckets: {}
      }`,
    )
    .collect();
  const tool = createShowTelemetryRollupTool({ db });
  const out = await tool.handler({ faculty: 'reinforcement' });
  const p = payload(out);
  assert.equal(p.rows.length, 1);
  assert.equal(p.rows[0].faculty, 'reinforcement');
  await close(db);
});

test('show_telemetry_rollup filters by event_kind', async () => {
  const db = await fresh();
  await db.query('UPDATE runtime:`telemetry.config` SET value.shadow_mode = false').collect();
  const now = new Date();
  await db
    .query(
      surql`CREATE telemetry_hourly CONTENT {
        hour: ${now}, faculty: 'intuition', event_kind: 'recall',
        count: 5, dimensions: {}, metric_sums: {}, metric_buckets: {}
      }`,
    )
    .collect();
  await db
    .query(
      surql`CREATE telemetry_hourly CONTENT {
        hour: ${now}, faculty: 'intuition', event_kind: 'recall_attribution',
        count: 2, dimensions: {}, metric_sums: {}, metric_buckets: {}
      }`,
    )
    .collect();
  const tool = createShowTelemetryRollupTool({ db });
  const out = await tool.handler({ event_kind: 'recall_attribution' });
  const p = payload(out);
  assert.equal(p.rows.length, 1);
  assert.equal(p.rows[0].event_kind, 'recall_attribution');
  await close(db);
});

test('show_telemetry_rollup window outside range returns no rows', async () => {
  const db = await fresh();
  await db.query('UPDATE runtime:`telemetry.config` SET value.shadow_mode = false').collect();
  // Row 30 days in the past — PT24H window won't catch it.
  const old = new Date(Date.now() - 30 * 86_400_000);
  await db
    .query(
      surql`CREATE telemetry_hourly CONTENT {
        hour: ${old}, faculty: 'intuition', event_kind: 'recall',
        count: 5, dimensions: {}, metric_sums: {}, metric_buckets: {}
      }`,
    )
    .collect();
  const tool = createShowTelemetryRollupTool({ db });
  const out = await tool.handler({ window: 'PT24H' });
  const p = payload(out);
  assert.equal(p.rows.length, 0);
  // P31D window catches it.
  const out2 = await tool.handler({ window: 'P31D' });
  const p2 = payload(out2);
  assert.equal(p2.rows.length, 1);
  await close(db);
});

test('show_telemetry_rollup respects limit', async () => {
  const db = await fresh();
  await db.query('UPDATE runtime:`telemetry.config` SET value.shadow_mode = false').collect();
  const now = new Date();
  for (let i = 0; i < 5; i++) {
    await db
      .query(
        surql`CREATE telemetry_hourly CONTENT {
          hour: ${now}, faculty: 'intuition', event_kind: 'recall',
          count: ${i}, dimensions: { idx: ${i.toString()} }, metric_sums: {}, metric_buckets: {}
        }`,
      )
      .collect();
  }
  const tool = createShowTelemetryRollupTool({ db });
  const out = await tool.handler({ limit: 2 });
  const p = payload(out);
  assert.equal(p.rows.length, 2);
  await close(db);
});

test('show_telemetry_rollup tool registers with correct name + schema', () => {
  const tool = createShowTelemetryRollupTool({ db: null });
  assert.equal(tool.name, 'show_telemetry_rollup');
  assert.equal(tool.inputSchema.type, 'object');
  assert.ok(tool.inputSchema.properties.faculty);
  assert.ok(tool.inputSchema.properties.event_kind);
  assert.ok(tool.inputSchema.properties.window);
  assert.ok(tool.inputSchema.properties.limit);
});
