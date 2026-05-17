// cost-monitor.test.js — unit tests for the Phase 2 cost monitor.
//
// Uses mem:// DB + runMigrations.  No real LLM calls.  The 6-hour sub-tick
// gate is tested by verifying cost_monitor_last_run_at is stamped and the
// second call is skipped.

import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { writeConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import {
  COST_MONITOR_INTERVAL_MS,
  runCostMonitor,
} from '../../cognition/jobs/cost-monitor.js';

const TEST_HOME = join(
  tmpdir(),
  `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
);
mkdirSync(TEST_HOME, { recursive: true });
process.env.ROBIN_HOME = TEST_HOME;
await writeConfig({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  return db;
}

async function enableV2(db, extra = {}) {
  const fields = { enabled: true, ...extra };
  const setClauses = Object.entries(fields)
    .map(([k, v]) => `value.${k} = ${JSON.stringify(v)}`)
    .join(', ');
  await db
    .query(`UPSERT runtime:\`self-improvement-v2\` SET ${setClauses}`)
    .collect();
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

test('COST_MONITOR_INTERVAL_MS is 6 hours', () => {
  assert.equal(COST_MONITOR_INTERVAL_MS, 6 * 60 * 60_000);
});

// ---------------------------------------------------------------------------
// Gate: flag off
// ---------------------------------------------------------------------------

test('returns skipped=flag_off when v2 is not enabled', async () => {
  const db = await fresh();
  const result = await runCostMonitor({ db });
  assert.equal(result, 'skipped=flag_off');
  await close(db);
});

// ---------------------------------------------------------------------------
// Sub-tick gate
// ---------------------------------------------------------------------------

test('runs on first call and stamps cost_monitor_last_run_at', async () => {
  const db = await fresh();
  await enableV2(db);

  const before = Date.now();
  const result = await runCostMonitor({ db });
  const after = Date.now();

  // Should not be 'skipped=flag_off' or 'skipped=too_soon'.
  assert.ok(
    !result.startsWith('skipped'),
    `expected non-skip on first call, got: ${result}`,
  );

  // Stamp should be written.
  const [rows] = await db
    .query("SELECT VALUE value FROM runtime:`self-improvement-v2`")
    .collect();
  const lastRun = rows?.[0]?.cost_monitor_last_run_at;
  assert.ok(lastRun, 'cost_monitor_last_run_at should be stamped');
  const ts = new Date(lastRun).getTime();
  assert.ok(ts >= before && ts <= after, 'timestamp within test window');
  await close(db);
});

test('returns skipped=too_soon on second call within 6h', async () => {
  const db = await fresh();
  // Stamp last_run_at as "just now" so the second call is within the gate.
  await enableV2(db, { cost_monitor_last_run_at: new Date().toISOString() });

  const result = await runCostMonitor({ db });
  assert.equal(result, 'skipped=too_soon');
  await close(db);
});

test('runs again after 6h have elapsed', async () => {
  const db = await fresh();
  // Stamp last_run_at as 7 hours ago.
  const sevenHoursAgo = new Date(Date.now() - 7 * 60 * 60_000).toISOString();
  await enableV2(db, { cost_monitor_last_run_at: sevenHoursAgo });

  const result = await runCostMonitor({ db });
  assert.ok(
    !result.startsWith('skipped'),
    `expected non-skip after 6h, got: ${result}`,
  );
  await close(db);
});

// ---------------------------------------------------------------------------
// Cost computation and alert path
// ---------------------------------------------------------------------------

test('returns ok result when cost is below 2x budget', async () => {
  const db = await fresh();
  await enableV2(db);

  // No cadence_telemetry or telemetry_hourly rows → cost = 0 → no alert.
  const result = await runCostMonitor({ db });
  assert.match(result, /^ok cost_6h=/);
  await close(db);
});

test('writes watch-list event and returns alert when projected cost > 2x budget', async () => {
  const db = await fresh();

  // Set a very small daily budget so even a tiny token spend triggers.
  await db
    .query(`UPSERT runtime:\`introspection.config\` SET value.daily_cost_budget_usd = 0.0001`)
    .collect();
  await enableV2(db);

  // Seed a cadence_telemetry row with a large token count in the 6h window.
  // TOKEN_COST_RATE = 0.000002, so 1_000_000 tokens = $2.00 per 6h → $8.00/day.
  // 2× budget = $0.0002 → well above threshold.
  const sixHoursAgo = new Date(Date.now() - 3 * 60 * 60_000); // 3h ago (within 6h window)
  await db
    .query(
      surql`CREATE cadence_telemetry CONTENT {
        step:       'introspection.grade',
        ts:         ${sixHoursAgo},
        tokens_in:  500000,
        tokens_out: 500000,
        duration_ms: 1000,
        success:    true
      }`,
    )
    .collect();

  const result = await runCostMonitor({ db });
  assert.match(result, /^alert=true/, `expected alert, got: ${result}`);

  // A watch-list event should have been written.
  const [evts] = await db
    .query(`SELECT * FROM events WHERE source = 'agent_internal' AND meta.kind = 'cost_monitor_alert'`)
    .collect();
  assert.ok(Array.isArray(evts) && evts.length > 0, 'watch-list event should be written');
  assert.ok(evts[0].meta.surface_in_brief === true, 'surface_in_brief should be true');
  assert.ok(typeof evts[0].content === 'string' && evts[0].content.includes('WARNING'), 'content should contain WARNING');
  await close(db);
});

test('does not write alert event when cost is within budget', async () => {
  const db = await fresh();
  // Generous daily budget → no alert expected.
  await db
    .query(`UPSERT runtime:\`introspection.config\` SET value.daily_cost_budget_usd = 100.0`)
    .collect();
  await enableV2(db);

  // Tiny token count.
  const recent = new Date(Date.now() - 60 * 60_000);
  await db
    .query(
      surql`CREATE cadence_telemetry CONTENT {
        step:       'introspection.grade',
        ts:         ${recent},
        tokens_in:  100,
        tokens_out: 100,
        duration_ms: 50,
        success:    true
      }`,
    )
    .collect();

  await runCostMonitor({ db });

  const [evts] = await db
    .query(`SELECT * FROM events WHERE source = 'agent_internal' AND meta.kind = 'cost_monitor_alert'`)
    .collect();
  assert.ok(!evts || evts.length === 0, 'no alert event should be written within budget');
  await close(db);
});

// ---------------------------------------------------------------------------
// telemetry_hourly source path (higher-priority)
// ---------------------------------------------------------------------------

test('prefers telemetry_hourly over cadence_telemetry when hourly has cost data', async () => {
  const db = await fresh();

  // Set a very small budget so telemetry_hourly data triggers the alert too.
  await db
    .query(`UPSERT runtime:\`introspection.config\` SET value.daily_cost_budget_usd = 0.0001`)
    .collect();
  await enableV2(db);

  // Insert a telemetry_hourly row for the current hour with a large cost_usd_sum.
  const currentHour = new Date(Math.floor(Date.now() / (60 * 60_000)) * (60 * 60_000));
  await db
    .query(
      surql`CREATE telemetry_hourly CONTENT {
        hour:         ${currentHour},
        faculty:      'introspection',
        event_kind:   'llm_call',
        dimensions:   {},
        count:        10,
        metric_sums:  { cost_usd_sum: 2.0 },
        metric_buckets: {}
      }`,
    )
    .collect();

  const result = await runCostMonitor({ db });
  assert.match(result, /^alert=true/, `expected alert from telemetry_hourly, got: ${result}`);
  await close(db);
});
