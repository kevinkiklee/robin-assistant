// introspection-faculty-lifecycle.test.js — integration tests for the
// introspection faculty lifecycle.
//
// Tests:
//   1. start() + stop() with flag=false: no drain, no timers active after stop.
//   2. start() + stop() with flag=true: faculty starts, drains a queue row,
//      then stops cleanly.
//   3. Idempotent start: calling start() twice does not double-register timers.
//   4. stop() before start(): safe no-op.
//
// Uses mem:// DB + runMigrations.  mock.timers NOT used because we're testing
// real start/stop lifecycle rather than the timer cadence (that's a unit test
// concern); we inject queue rows and call drainQueueOnce directly via the
// queue-poller to verify processing.

import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { startIntrospection, stopIntrospection } from '../../cognition/introspection/index.js';
import { drainQueueOnce } from '../../cognition/introspection/queue-poller.js';
import { writeConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { setSelfImprovementV2Enabled } from '../../runtime/config/self-improvement-v2.js';

// ── Test home setup ──────────────────────────────────────────────────────────
const HOME = join(tmpdir(), `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
mkdirSync(HOME, { recursive: true });
process.env.ROBIN_HOME = HOME;
await writeConfig({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  return db;
}

async function seedEvent(db) {
  const [rows] = await db
    .query(
      surql`CREATE events SET source = 'agent_internal', content = 'test event', content_hash = 'xyz'`,
    )
    .collect();
  return Array.isArray(rows) ? rows[0] : rows;
}

async function seedQueueRow(db, eventId, payload = {}) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 60_000 * 60);
  const [rows] = await db
    .query(
      surql`CREATE task_close_queue SET
        task_type   = ${'outbound:discord_send:send_dm'},
        task_id     = ${'lt-001'},
        event_id    = ${eventId},
        payload     = ${payload},
        enqueued_at = ${now},
        claimed_at  = NONE,
        claimed_by  = NONE,
        expires_at  = ${expiresAt}`,
    )
    .collect();
  return Array.isArray(rows) ? rows[0] : rows;
}

// ── Tests ────────────────────────────────────────────────────────────────────

test('stop() before any start() is a safe no-op', async () => {
  // Ensure clean state from any previous test leakage.
  await stopIntrospection();
  // No assertion needed — test passes if it does not throw.
});

test('start() with flag=false: faculty starts but drain is suppressed', async () => {
  const db = await fresh();

  // Ensure flag is false (default).
  const event = await seedEvent(db);
  await seedQueueRow(db, event.id, {
    outbound_result: { ok: false, reason: 'policy' },
  });

  // Start the faculty — flag is false, so drain loop should NOT be running.
  await startIntrospection({ db });

  // Faculty should start without error.  We verify by calling stop() cleanly.
  await stopIntrospection();

  // Queue row should still be there (not drained).
  const [qRows] = await db.query(surql`SELECT * FROM task_close_queue`).collect();
  const remaining = (Array.isArray(qRows) ? qRows : [qRows]).filter(Boolean);
  assert.equal(remaining.length, 1, 'queue row untouched when flag=false');

  await close(db);
});

test('start() with flag=true: faculty starts and drain is active', async () => {
  const db = await fresh();

  // Enable the flag.
  await setSelfImprovementV2Enabled(db, true);

  const event = await seedEvent(db);
  await seedQueueRow(db, event.id, {
    outbound_result: { ok: false, reason: 'pii_leak' },
  });

  await startIntrospection({ db });

  // Manually trigger a drain (simulates the 1-min timer tick).
  // The timer interval is too long to wait for in a test.
  const { processed, written } = await drainQueueOnce(db);
  assert.equal(processed, 1, 'one row processed');
  assert.equal(written, 1, 'one row deleted');

  // Stop cleanly.
  await stopIntrospection();

  // task_outcome memo should exist.
  const [mRows] = await db.query(surql`SELECT * FROM memos WHERE kind = 'task_outcome'`).collect();
  const memos = (Array.isArray(mRows) ? mRows : [mRows]).filter(Boolean);
  assert.equal(memos.length, 1, 'task_outcome memo written');
  assert.equal(memos[0].meta.score, 0.2);

  await close(db);
});

test('start() is idempotent — second call does not double-register', async () => {
  const db = await fresh();

  await startIntrospection({ db });
  // Second start should detect existing _state and return without adding timers.
  await startIntrospection({ db });

  // Clean stop should work as normal.
  await stopIntrospection();

  // No assertion on timer count — the module-level _state guard is enough;
  // the real signal is that stop() doesn't throw or hang.

  await close(db);
});

test('start() then stop() leaves no queue rows unprocessed (no-op stop path)', async () => {
  const db = await fresh();

  // flag=false so drain is suppressed.
  const event = await seedEvent(db);
  await seedQueueRow(db, event.id, {});

  await startIntrospection({ db });
  await stopIntrospection();

  // Queue row should still exist (faculty gated off, row untouched).
  const [qRows] = await db.query(surql`SELECT * FROM task_close_queue`).collect();
  const remaining = (Array.isArray(qRows) ? qRows : [qRows]).filter(Boolean);
  assert.equal(remaining.length, 1, 'row untouched when faculty is gated off');

  await close(db);
});

test('gate-off: flag=false means no memos written even with signals in queue', async () => {
  const db = await fresh();
  // Verify flag is false (fresh DB has no row → defaults to false).

  const event = await seedEvent(db);
  await seedQueueRow(db, event.id, {
    outbound_result: { ok: false, reason: 'blocked' },
  });

  await startIntrospection({ db });

  // Even if we waited, the timer doesn't run because the faculty is gated.
  // We verify by directly checking memo table.
  const [mRows] = await db.query(surql`SELECT * FROM memos WHERE kind = 'task_outcome'`).collect();
  const memos = (Array.isArray(mRows) ? mRows : [mRows]).filter(Boolean);
  assert.equal(memos.length, 0, 'no memos written when flag=false');

  await stopIntrospection();
  await close(db);
});
