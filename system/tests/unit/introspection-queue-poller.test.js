// introspection-queue-poller.test.js — unit tests for drainQueueOnce.
//
// Inserts a task_close_queue row with an outbound-blocked signal,
// calls drainQueueOnce, and asserts:
//   - task_outcome memo written with score=0.2 and signals.outbound_blocked
//   - queue row deleted
//
// Also tests:
//   - Empty queue → { processed:0, written:0, errors:0 }
//   - Expired row is not claimed
//   - No-signal row is deleted without writing a memo

import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { drainQueueOnce } from '../../cognition/introspection/queue-poller.js';
import { writeConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';

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

/**
 * Create a minimal events row (required for the task_close_queue FK).
 */
async function seedEvent(db) {
  const [rows] = await db
    .query(
      surql`CREATE events SET source = 'agent_internal', content = 'test', content_hash = 'abc'`,
    )
    .collect();
  const row = Array.isArray(rows) ? rows[0] : rows;
  return row;
}

/**
 * Create a task_close_queue row that expires in the future.
 */
async function seedQueueRow(db, eventId, payload = {}) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 60_000 * 60); // 1h
  const [rows] = await db
    .query(
      surql`CREATE task_close_queue SET
        task_type   = ${'outbound:discord_send:send_dm'},
        task_id     = ${'task-001'},
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

test('empty queue returns { processed:0, written:0, errors:0 }', async () => {
  const db = await fresh();
  const result = await drainQueueOnce(db);
  assert.deepEqual(result, { processed: 0, written: 0, errors: 0, graded: 0 });
  await close(db);
});

test('outbound-blocked row: writes task_outcome memo with score=0.2 and deletes the row', async () => {
  const db = await fresh();
  const event = await seedEvent(db);
  await seedQueueRow(db, event.id, {
    outbound_result: { ok: false, reason: 'content_policy' },
  });

  const { processed, written, errors } = await drainQueueOnce(db);
  assert.equal(processed, 1);
  assert.equal(written, 1);
  assert.equal(errors, 0);

  // Queue should be empty.
  const [qRows] = await db.query(surql`SELECT * FROM task_close_queue`).collect();
  assert.equal(
    (Array.isArray(qRows) ? qRows : [qRows]).filter(Boolean).length,
    0,
    'queue row deleted',
  );

  // task_outcome memo should exist.
  const [mRows] = await db.query(surql`SELECT * FROM memos WHERE kind = 'task_outcome'`).collect();
  const memos = (Array.isArray(mRows) ? mRows : [mRows]).filter(Boolean);
  assert.equal(memos.length, 1, 'one task_outcome memo written');

  const memo = memos[0];
  assert.equal(memo.kind, 'task_outcome');
  assert.ok(memo.content.includes('outbound_blocked'), 'content mentions outbound_blocked');
  assert.equal(memo.meta.score, 0.2);
  assert.ok('outbound_blocked' in memo.meta.signals, 'signals.outbound_blocked present');
  assert.equal(memo.meta.signals.outbound_blocked.reason, 'content_policy');
  assert.equal(memo.meta.task_type, 'outbound:discord_send:send_dm');
  assert.equal(memo.meta.task_id, 'task-001');

  await close(db);
});

test('explicit-correction row: writes task_outcome memo with score=0.0', async () => {
  const db = await fresh();
  const event = await seedEvent(db);
  await seedQueueRow(db, event.id, {
    correction_followup: { is_followup: true },
  });

  await drainQueueOnce(db);

  const [mRows] = await db.query(surql`SELECT * FROM memos WHERE kind = 'task_outcome'`).collect();
  const memos = (Array.isArray(mRows) ? mRows : [mRows]).filter(Boolean);
  assert.equal(memos.length, 1);
  assert.equal(memos[0].meta.score, 0.0);
  assert.ok('explicit_correction' in memos[0].meta.signals);

  await close(db);
});

test('no-signal row: deleted without writing a memo', async () => {
  const db = await fresh();
  const event = await seedEvent(db);
  // Empty payload → no structural signals.
  await seedQueueRow(db, event.id, {});

  const { processed, written } = await drainQueueOnce(db);
  assert.equal(processed, 1);
  assert.equal(written, 1); // "written" counts deletions even without memos

  // No memos.
  const [mRows] = await db.query(surql`SELECT * FROM memos WHERE kind = 'task_outcome'`).collect();
  const memos = (Array.isArray(mRows) ? mRows : [mRows]).filter(Boolean);
  assert.equal(memos.length, 0, 'no memo for no-signal row');

  // Queue empty.
  const [qRows] = await db.query(surql`SELECT * FROM task_close_queue`).collect();
  assert.equal((Array.isArray(qRows) ? qRows : [qRows]).filter(Boolean).length, 0);

  await close(db);
});

test('expired row is not claimed by drain', async () => {
  const db = await fresh();
  const event = await seedEvent(db);

  // Insert a row that is already expired.
  const past = new Date(Date.now() - 5_000);
  await db
    .query(
      surql`CREATE task_close_queue SET
        task_type   = ${'turn:default'},
        task_id     = ${'expired-task'},
        event_id    = ${event.id},
        payload     = ${{ outbound_result: { ok: false, reason: 'expired' } }},
        enqueued_at = ${past},
        claimed_at  = NONE,
        claimed_by  = NONE,
        expires_at  = ${past}`,
    )
    .collect();

  const { processed } = await drainQueueOnce(db);
  assert.equal(processed, 0, 'expired row should not be claimed');

  await close(db);
});

test('multiple rows: all processed in one tick', async () => {
  const db = await fresh();
  const e1 = await seedEvent(db);
  const e2 = await seedEvent(db);
  const e3 = await seedEvent(db);

  // One blocked, one correction, one empty.
  await seedQueueRow(db, e1.id, { outbound_result: { ok: false, reason: 'pii' } });
  await seedQueueRow(db, e2.id, { correction_followup: { is_followup: true } });
  await seedQueueRow(db, e3.id, {});

  const { processed, written } = await drainQueueOnce(db);
  assert.equal(processed, 3);
  assert.equal(written, 3); // all three processed (deleted)

  const [mRows] = await db.query(surql`SELECT * FROM memos WHERE kind = 'task_outcome'`).collect();
  const memos = (Array.isArray(mRows) ? mRows : [mRows]).filter(Boolean);
  assert.equal(memos.length, 2, 'two memos: blocked + correction; empty has no memo');

  await close(db);
});

test('recall-fingerprint-reuse row: writes memo with score=0.3', async () => {
  const db = await fresh();
  const event = await seedEvent(db);
  await seedQueueRow(db, event.id, {
    recall_signal: {
      fingerprint: 'fp-xyz',
      top_k_ids: ['events:new1', 'events:new2'],
      session_prior_top_k_ids: ['events:old1', 'events:old2'],
    },
  });

  await drainQueueOnce(db);

  const [mRows] = await db.query(surql`SELECT * FROM memos WHERE kind = 'task_outcome'`).collect();
  const memos = (Array.isArray(mRows) ? mRows : [mRows]).filter(Boolean);
  assert.equal(memos.length, 1);
  assert.equal(memos[0].meta.score, 0.3);
  assert.ok('recall_fingerprint_reuse' in memos[0].meta.signals);

  await close(db);
});
