// tests/unit/resolve-due-predictions.test.js
//
// Spec §4a — heartbeat-driven prediction resolution.
// Uses mem:// DB + real migrations; no real timers.

import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { BoundQuery } from 'surrealdb';
import {
  resolveDuePredictions,
  resolveEventTiming,
  needsUser,
} from '../../cognition/jobs/resolve-due-predictions.js';
import { recordPrediction, getPrediction } from '../../cognition/jobs/predictions.js';
import { writeConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';

const __h = join(tmpdir(), `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
mkdirSync(__h, { recursive: true });
process.env.ROBIN_HOME = __h;
await writeConfig({ embedder_profile: 'mxbai-1024' });

const MIGRATIONS_DIR = resolve(import.meta.dirname, '../../data/db/migrations');

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, MIGRATIONS_DIR);
  return db;
}

// Helper: enable self-improvement-v2 flag
async function enableFlag(db) {
  await db.query('UPSERT runtime:`self-improvement-v2` SET value.enabled = true').collect();
}

// Helper: create a prediction with expected_resolution_at in the past
async function pastPrediction(
  db,
  { kind, pastMs = 10 * 60_000, statement = 'will it happen?' } = {},
) {
  const expected_resolution_at = new Date(Date.now() - pastMs).toISOString();
  const { id } = await recordPrediction(db, {
    statement,
    kind,
    confidence: 0.7,
    expected_resolution_at,
  });
  return id;
}

// Helper: create a prediction with expected_resolution_at in the future
async function futurePrediction(db, { kind = 'event_timing' } = {}) {
  const expected_resolution_at = new Date(Date.now() + 60 * 60_000).toISOString();
  const { id } = await recordPrediction(db, {
    statement: 'this will happen later',
    kind,
    confidence: 0.6,
    expected_resolution_at,
  });
  return id;
}

// ---------------------------------------------------------------------------
// 1. Flag off → no-op
// ---------------------------------------------------------------------------
test('flag off → resolveDuePredictions returns skipped=flag_off', async () => {
  const db = await fresh();
  // Flag not set (default false)
  await pastPrediction(db, { kind: 'event_timing' });
  const result = await resolveDuePredictions({ db });
  assert.equal(result, 'skipped=flag_off');
  await close(db);
});

// ---------------------------------------------------------------------------
// 2. event_timing with evidence present → auto-resolved correct: true
// ---------------------------------------------------------------------------
test('event_timing: evidence present → auto-resolved correct=true', async () => {
  const db = await fresh();
  await enableFlag(db);

  // Create prediction with expected_resolution_at 30 minutes ago
  const expectedAt = new Date(Date.now() - 30 * 60_000);
  const { id } = await recordPrediction(db, {
    statement: 'deploy will complete',
    kind: 'event_timing',
    confidence: 0.8,
    expected_resolution_at: expectedAt.toISOString(),
  });

  // Insert a runtime_jobs row with last_run_at near the expected time (within 15 min window)
  const jobRunAt = new Date(expectedAt.getTime() + 5 * 60_000); // 5 min after expected
  await db
    .query(
      new BoundQuery(
        `INSERT INTO runtime_jobs {
          name: 'test-event-job',
          enabled: true,
          schedule: '*/5 * * * *',
          runtime: 'internal',
          catch_up: false,
          notify: 'none',
          notify_on_failure: false,
          timeout_minutes: 2,
          in_flight: false,
          last_run_at: $ran
        }`,
        { ran: jobRunAt },
      ),
    )
    .collect();

  // Use the resolver directly with a mock prediction object
  const prediction = {
    id,
    statement: 'deploy will complete',
    kind: 'event_timing',
    confidence: 0.8,
    expected_resolution_at: expectedAt,
    meta: { job_name: 'test-event-job', statement_kind: 'event_timing' },
  };
  const outcome = await resolveEventTiming(db, prediction);
  assert.equal(outcome.resolution, 'auto');
  assert.equal(outcome.correct, true);
  assert.ok(outcome.actual_outcome.includes('test-event-job'));
  await close(db);
});

// ---------------------------------------------------------------------------
// 3. event_timing: evidence absent past 24h → auto-resolved correct: false
// ---------------------------------------------------------------------------
test('event_timing: no evidence and past 24h → auto-resolved correct=false', async () => {
  const db = await fresh();
  await enableFlag(db);

  // expected_resolution_at is 25 hours in the past — past the 24h horizon
  const expectedAt = new Date(Date.now() - 25 * 60 * 60_000);
  const { id } = await recordPrediction(db, {
    statement: 'meeting will be cancelled',
    kind: 'event_timing',
    confidence: 0.5,
    expected_resolution_at: expectedAt.toISOString(),
  });

  const prediction = {
    id,
    statement: 'meeting will be cancelled',
    kind: 'event_timing',
    confidence: 0.5,
    expected_resolution_at: expectedAt,
    meta: { statement_kind: 'event_timing' },
  };
  const outcome = await resolveEventTiming(db, prediction);
  assert.equal(outcome.resolution, 'auto');
  assert.equal(outcome.correct, false);
  assert.ok(outcome.actual_outcome.includes('24h'));
  await close(db);
});

// ---------------------------------------------------------------------------
// 4. fact_recall → always needs_user (sets flag, doesn't resolve)
// ---------------------------------------------------------------------------
test('fact_recall → needs_user; surface_in_brief set, resolved_at not set', async () => {
  const db = await fresh();
  await enableFlag(db);

  const id = await pastPrediction(db, { kind: 'fact_recall', pastMs: 20 * 60_000 });

  const summary = await resolveDuePredictions({ db });
  assert.match(summary, /needs_user=1/);
  assert.match(summary, /resolved=0/);

  // Verify the memo was mutated: surface_in_brief=true, resolved_at still absent
  const row = await getPrediction(db, id);
  // resolved_at should not be set (not auto-resolved)
  assert.equal(row.resolved_at, null);
  // surface_in_brief should be true in meta — query by kind to avoid RecordId coercion
  const [rawRows] = await db
    .query(
      new BoundQuery(
        "SELECT meta FROM memos WHERE kind = 'prediction' AND meta.statement_kind = $k LIMIT 1",
        { k: 'fact_recall' },
      ),
    )
    .collect();
  const meta = rawRows?.[0]?.meta ?? {};
  assert.equal(meta.surface_in_brief, true);
  assert.equal(meta.resolution_status, 'needs_user');
  await close(db);
});

// ---------------------------------------------------------------------------
// 5. Prediction still within grace window → not touched
// ---------------------------------------------------------------------------
test('prediction within expected_resolution_at window → not touched', async () => {
  const db = await fresh();
  await enableFlag(db);

  const id = await futurePrediction(db, { kind: 'event_timing' });

  const summary = await resolveDuePredictions({ db });
  assert.equal(summary, 'checked=0 resolved=0 needs_user=0');

  const row = await getPrediction(db, id);
  assert.equal(row.resolved_at, null);
  await close(db);
});

// ---------------------------------------------------------------------------
// 6. Unknown statement_kind → safely falls through to needsUser
// ---------------------------------------------------------------------------
test('unknown statement_kind → needsUser (no throw)', async () => {
  const db = await fresh();
  await enableFlag(db);

  // Bypass recordPrediction's kind validation by writing directly to memos
  const pastTs = new Date(Date.now() - 10 * 60_000);
  await db
    .query(
      new BoundQuery(
        `CREATE memos CONTENT {
          kind: 'prediction',
          content: 'something weird will happen',
          confidence: 0.5,
          derived_by: 'manual',
          meta: {
            statement_kind: 'totally_unknown_kind',
            expected_resolution_at: $ts
          }
        }`,
        { ts: pastTs },
      ),
    )
    .collect();

  const summary = await resolveDuePredictions({ db });
  // Should handle it as needs_user without throwing
  assert.match(summary, /needs_user=1/);
  assert.match(summary, /resolved=0/);
  await close(db);
});

// ---------------------------------------------------------------------------
// 7. needsUser() helper contract
// ---------------------------------------------------------------------------
test('needsUser always returns resolution=needs_user with kind in reason', async () => {
  const db = await fresh();
  const prediction = { kind: 'preference_guess', meta: {} };
  const result = await needsUser(db, prediction);
  assert.equal(result.resolution, 'needs_user');
  assert.ok(result.reason.includes('preference_guess'));
  await close(db);
});

// ---------------------------------------------------------------------------
// 8. Full tick: mixed prediction kinds — counts are accurate
// ---------------------------------------------------------------------------
test('full tick with mixed kinds: resolved + needs_user counts are accurate', async () => {
  const db = await fresh();
  await enableFlag(db);

  // Two fact_recall → both need_user
  await pastPrediction(db, { kind: 'fact_recall', pastMs: 15 * 60_000, statement: 'f1' });
  await pastPrediction(db, { kind: 'preference_guess', pastMs: 20 * 60_000, statement: 'f2' });

  // One event_timing past 24h with no evidence → auto correct=false
  const old = new Date(Date.now() - 25 * 60 * 60_000).toISOString();
  await recordPrediction(db, {
    statement: 'stale event timing',
    kind: 'event_timing',
    confidence: 0.6,
    expected_resolution_at: old,
  });

  const summary = await resolveDuePredictions({ db });
  assert.match(summary, /checked=3/);
  assert.match(summary, /resolved=1/);
  assert.match(summary, /needs_user=2/);
  await close(db);
});
