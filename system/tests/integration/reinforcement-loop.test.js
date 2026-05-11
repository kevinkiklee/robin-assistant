// Verifies the recall-reinforcement loop, the "keystone effectiveness fix"
// described in HANDOFF.md. Promoted from scripts/test-reinforcement-smoke.mjs
// so regressions in this loop fail CI.

import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import { test } from 'node:test';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import * as store from '../../src/memory/store.js';
import { evaluatePending } from '../../src/recall/reinforcement.js';
import { writeConfig as __robinWriteConfig } from '../../src/runtime/config.js';

// __robin_test_home_setup__
const __robinTestHome = __robinJoin(
  __robinTmpdir(),
  `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
);
__robinMkdirSync(__robinTestHome, { recursive: true });
process.env.ROBIN_HOME = __robinTestHome;
await __robinWriteConfig({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return db;
}

const fakeEmbedder = { embed: async () => new Float32Array(1024) };

test('reinforcement: pending recall with no correction → reinforced + signal_count incremented', async () => {
  const db = await fresh();
  const m = await store.note(db, fakeEmbedder, 'knowledge', {
    content: 'Test fact for reinforcement',
    derived_by: 'manual',
  });
  const [before] = await db.query(`SELECT signal_count FROM ${m.id}`).collect();
  const initial = before[0].signal_count;

  const pastTs = new Date(Date.now() - 10 * 60 * 1000);
  await db
    .query(
      `CREATE recall_log CONTENT {
         ts: $ts, session_id: 'test-session', query: 'q',
         k: 1, ranked_hits: $hits, outcome: 'pending'
       }`,
      { ts: pastTs, hits: [{ memo_id: m.id, rank: 0 }] },
    )
    .collect();

  const summary = await evaluatePending(db);
  assert.equal(summary.reinforced, 1, 'one row should be reinforced');
  assert.equal(summary.corrected, 0);
  assert.equal(summary.no_signal, 0);

  const [after] = await db.query(`SELECT signal_count FROM ${m.id}`).collect();
  assert.equal(after[0].signal_count, initial + 1, 'signal_count should increment');

  const [logs] = await db.query('SELECT outcome FROM recall_log').collect();
  assert.deepEqual(
    logs.map((l) => l.outcome),
    ['reinforced'],
  );
  await close(db);
});

test('reinforcement: correction in window → marked corrected, signal_count NOT bumped', async () => {
  const db = await fresh();
  const m = await store.note(db, fakeEmbedder, 'knowledge', {
    content: 'A fact that gets corrected',
    derived_by: 'manual',
  });
  const [before] = await db.query(`SELECT signal_count FROM ${m.id}`).collect();
  const initial = before[0].signal_count;

  const pastTs = new Date(Date.now() - 10 * 60 * 1000);
  await db
    .query(
      `CREATE recall_log CONTENT {
         ts: $ts, session_id: 'session-corrected', query: 'q',
         k: 1, ranked_hits: $hits, outcome: 'pending'
       }`,
      { ts: pastTs, hits: [{ memo_id: m.id, rank: 0 }] },
    )
    .collect();
  // Correction event 1 minute after the recall, same session.
  await db
    .query(
      `CREATE events CONTENT {
         source: 'manual',
         content: 'no, that was wrong',
         ts: $ts,
         meta: { kind: 'correction', session_id: 'session-corrected' }
       }`,
      { ts: new Date(pastTs.getTime() + 60_000) },
    )
    .collect();

  const summary = await evaluatePending(db);
  assert.equal(summary.corrected, 1);
  assert.equal(summary.reinforced, 0);

  const [after] = await db.query(`SELECT signal_count FROM ${m.id}`).collect();
  assert.equal(
    after[0].signal_count,
    initial,
    'signal_count must NOT bump when a correction landed in the window',
  );
  await close(db);
});

test('reinforcement: pending recall with empty hits → evaluated_no_signal (idempotent)', async () => {
  const db = await fresh();
  const pastTs = new Date(Date.now() - 10 * 60 * 1000);
  await db
    .query(
      `CREATE recall_log CONTENT {
         ts: $ts, session_id: 's', query: 'q',
         k: 0, ranked_hits: [], outcome: 'pending'
       }`,
      { ts: pastTs },
    )
    .collect();

  const summary = await evaluatePending(db);
  assert.equal(summary.no_signal, 1);
  assert.equal(summary.reinforced, 0);
  assert.equal(summary.corrected, 0);

  // Re-running should be a no-op (rows no longer have outcome='pending').
  const summary2 = await evaluatePending(db);
  assert.equal(summary2.evaluated, 0);
  await close(db);
});

test('reinforcement: rows newer than the window are not evaluated', async () => {
  const db = await fresh();
  const m = await store.note(db, fakeEmbedder, 'knowledge', {
    content: 'Recent memo',
    derived_by: 'manual',
  });
  // Recent recall_log row — 1 minute ago, within the 5-min window.
  const recentTs = new Date(Date.now() - 60_000);
  await db
    .query(
      `CREATE recall_log CONTENT {
         ts: $ts, session_id: 's', query: 'q',
         k: 1, ranked_hits: $hits, outcome: 'pending'
       }`,
      { ts: recentTs, hits: [{ memo_id: m.id, rank: 0 }] },
    )
    .collect();

  const summary = await evaluatePending(db);
  assert.equal(summary.evaluated, 0, 'rows inside the window should not be evaluated yet');
  await close(db);
});
