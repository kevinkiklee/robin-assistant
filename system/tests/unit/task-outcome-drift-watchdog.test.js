// task-outcome-drift-watchdog.test.js — unit tests for the Phase 2 drift watchdog.
//
// Uses mem:// DB + runMigrations.  No real LLM calls.  mock.timers not needed
// because the watchdog reads dates from DB rows, not from Date.now() directly
// (sub-tick gating is internal to cost-monitor, not this module).

import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import {
  BASELINE_WINDOW_MS,
  DRIFT_THRESHOLD,
  runTaskOutcomeDriftWatchdog,
  TRAILING_WINDOW_MS,
} from '../../cognition/jobs/task-outcome-drift-watchdog.js';
import { writeConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';

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

/** Enable the v2 flag so the watchdog doesn't no-op. */
async function enableV2(db, extra = {}) {
  const fields = { enabled: true, ...extra };
  const setClauses = Object.entries(fields)
    .map(([k, v]) => `value.${k} = ${JSON.stringify(v)}`)
    .join(', ');
  await db.query(`UPSERT runtime:\`self-improvement-v2\` SET ${setClauses}`).collect();
}

/** Seed `n` task_outcome memos at a specific timestamp. */
async function seedMemos(db, n, ts) {
  for (let i = 0; i < n; i++) {
    await db
      .query(
        surql`CREATE memos CONTENT {
          kind:       'task_outcome',
          content:    ${`task_outcome synthetic ${i}`},
          derived_by: 'introspection',
          derived_at: ${new Date(ts)},
          meta:       {}
        }`,
      )
      .collect();
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

test('exports expected constants', () => {
  assert.equal(BASELINE_WINDOW_MS, 72 * 60 * 60_000);
  assert.equal(TRAILING_WINDOW_MS, 60 * 60_000);
  assert.equal(DRIFT_THRESHOLD, 0.5);
});

// ---------------------------------------------------------------------------
// Gate: flag off
// ---------------------------------------------------------------------------

test('returns skipped=flag_off when v2 is not enabled', async () => {
  const db = await fresh();
  const result = await runTaskOutcomeDriftWatchdog({ db });
  assert.equal(result, 'skipped=flag_off');
  await close(db);
});

// ---------------------------------------------------------------------------
// Phase2 start stamp
// ---------------------------------------------------------------------------

test('stamps phase2_started_at on first run when flag is true', async () => {
  const db = await fresh();
  await enableV2(db);

  const before = Date.now();
  const result = await runTaskOutcomeDriftWatchdog({ db });
  const after = Date.now();

  assert.equal(result, 'phase2_started_at=stamped');

  const [rows] = await db.query('SELECT VALUE value FROM runtime:`self-improvement-v2`').collect();
  const v = rows?.[0];
  assert.ok(v?.phase2_started_at, 'phase2_started_at should be set');
  const stamped = new Date(v.phase2_started_at).getTime();
  assert.ok(stamped >= before && stamped <= after, 'timestamp within test window');
  await close(db);
});

test('does not re-stamp phase2_started_at on subsequent run', async () => {
  const db = await fresh();
  const firstStamp = new Date(Date.now() - 1000).toISOString();
  await enableV2(db, { phase2_started_at: firstStamp });

  // Baseline not yet locked → should return pending, not re-stamp.
  const result = await runTaskOutcomeDriftWatchdog({ db });
  assert.match(result, /^baseline=pending/);

  const [rows] = await db.query('SELECT VALUE value FROM runtime:`self-improvement-v2`').collect();
  assert.equal(rows?.[0]?.phase2_started_at, firstStamp, 'stamp should not change');
  await close(db);
});

// ---------------------------------------------------------------------------
// Baseline pending
// ---------------------------------------------------------------------------

test('returns baseline=pending when < 72h have elapsed since phase2_started_at', async () => {
  const db = await fresh();
  // 48 h ago — well within the 72 h window.
  const startedAt = new Date(Date.now() - 48 * 60 * 60_000).toISOString();
  await enableV2(db, { phase2_started_at: startedAt });

  const result = await runTaskOutcomeDriftWatchdog({ db });
  assert.match(result, /^baseline=pending remaining_h=\d+/);
  await close(db);
});

// ---------------------------------------------------------------------------
// Baseline lock
// ---------------------------------------------------------------------------

test('locks baseline_writes_per_hour after 72h', async () => {
  const db = await fresh();
  // 73 h ago — past the baseline window.
  const startedAt = new Date(Date.now() - 73 * 60 * 60_000);
  await enableV2(db, { phase2_started_at: startedAt.toISOString() });

  // Seed 72 memos spread across the 72 h window → 1 write/hour.
  for (let i = 0; i < 72; i++) {
    const ts = new Date(startedAt.getTime() + i * 60 * 60_000);
    await seedMemos(db, 1, ts.getTime());
  }

  const result = await runTaskOutcomeDriftWatchdog({ db });
  assert.match(result, /^baseline=locked/);

  const [rows] = await db.query('SELECT VALUE value FROM runtime:`self-improvement-v2`').collect();
  const v = rows?.[0];
  assert.ok(
    typeof v?.baseline_writes_per_hour === 'number',
    'baseline_writes_per_hour should be set',
  );
  assert.ok(v.baseline_writes_per_hour > 0, 'baseline should be positive');
  await close(db);
});

// ---------------------------------------------------------------------------
// Drift detection
// ---------------------------------------------------------------------------

test('returns ok when current rate is within drift threshold', async () => {
  const db = await fresh();
  const startedAt = new Date(Date.now() - 80 * 60 * 60_000);
  // baseline: 2 writes/hour
  await enableV2(db, {
    phase2_started_at: startedAt.toISOString(),
    baseline_writes_per_hour: 2,
  });

  // Seed 2 memos in the trailing 1 h → current rate = 2/h → 0% drift.
  const windowStart = Date.now() - TRAILING_WINDOW_MS;
  await seedMemos(db, 2, windowStart + 30 * 60_000);

  const result = await runTaskOutcomeDriftWatchdog({ db });
  assert.match(result, /^ok drift=/);
  // Flag should still be enabled.
  const [rows] = await db.query('SELECT VALUE value FROM runtime:`self-improvement-v2`').collect();
  assert.equal(rows?.[0]?.enabled, true);
  await close(db);
});

test('auto-disables flag when drift exceeds threshold', async () => {
  const db = await fresh();
  const startedAt = new Date(Date.now() - 80 * 60 * 60_000);
  // baseline: 2 writes/hour; threshold is 50%, so > 3 or < 1 triggers.
  await enableV2(db, {
    phase2_started_at: startedAt.toISOString(),
    baseline_writes_per_hour: 2,
  });

  // Seed 0 memos in the trailing 1 h → 100% below baseline → triggers.
  const result = await runTaskOutcomeDriftWatchdog({ db });
  assert.match(result, /^auto_disabled=true/);

  const [rows] = await db.query('SELECT VALUE value FROM runtime:`self-improvement-v2`').collect();
  const v = rows?.[0];
  assert.equal(v?.enabled, false, 'flag should be disabled');
  assert.ok(v?.auto_disabled_at, 'auto_disabled_at should be set');
  assert.ok(typeof v?.auto_disabled_reason === 'string', 'reason should be a string');
  await close(db);
});

test('auto-disables flag when rate is far above baseline', async () => {
  const db = await fresh();
  const startedAt = new Date(Date.now() - 80 * 60 * 60_000);
  // baseline: 2 writes/hour; 200% above baseline → drift > 50%.
  await enableV2(db, {
    phase2_started_at: startedAt.toISOString(),
    baseline_writes_per_hour: 2,
  });

  // Seed 6 memos in the trailing 1h → current = 6/h → 200% above.
  const windowStart = Date.now() - TRAILING_WINDOW_MS;
  await seedMemos(db, 6, windowStart + 15 * 60_000);

  const result = await runTaskOutcomeDriftWatchdog({ db });
  assert.match(result, /^auto_disabled=true/);
  await close(db);
});

test('no-op when baseline is zero', async () => {
  const db = await fresh();
  const startedAt = new Date(Date.now() - 80 * 60 * 60_000);
  await enableV2(db, {
    phase2_started_at: startedAt.toISOString(),
    baseline_writes_per_hour: 0,
  });

  const result = await runTaskOutcomeDriftWatchdog({ db });
  assert.equal(result, 'baseline=zero_skip');
  await close(db);
});
