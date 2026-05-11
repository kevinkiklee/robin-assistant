// Verifies the recall-reinforcement loop, the "keystone effectiveness fix"
// described in HANDOFF.md. Promoted from scripts/test-reinforcement-smoke.mjs
// so regressions in this loop fail CI.

import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import { test } from 'node:test';
import { evaluatePending } from '../../cognition/intuition/reinforcement.js';
import * as store from '../../cognition/memory/store.js';
import { writeConfig as __robinWriteConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';

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
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
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

test('B1: no reply event, fallback_when_no_reply=true -> row reinforced, used=true,used_via=fallback', async () => {
  const db = await fresh();
  await db
    .query("UPDATE runtime:`reinforcement.config` SET value.attribution_mode = 'hybrid'")
    .collect();
  const m = await store.note(db, fakeEmbedder, 'knowledge', {
    content: 'fact about birds',
    derived_by: 'manual',
  });
  const pastTs = new Date(Date.now() - 10 * 60 * 1000);
  await db
    .query(
      `CREATE recall_log CONTENT {
         ts: $ts, session_id: 'sess-fb', query: 'q', k: 1,
         ranked_hits: [{ record: $rid, kind: 'memo', rank: 0 }],
         outcome: 'pending'
       }`,
      { ts: pastTs, rid: String(m.id) },
    )
    .collect();
  const summary = await evaluatePending(db);
  assert.equal(summary.reinforced, 1);
  const [rows] = await db.query('SELECT ranked_hits, attribution FROM recall_log').collect();
  const hit = rows[0].ranked_hits[0];
  assert.equal(hit.used, true);
  assert.equal(hit.used_via, 'fallback');
  assert.equal(rows[0].attribution.mode, 'fallback_no_reply');
  await close(db);
});

test('B1: per-hit reinforce — only matched hits bump signal_count + corroborates', async () => {
  const db = await fresh();
  await db
    .query("UPDATE runtime:`reinforcement.config` SET value.attribution_mode = 'hybrid'")
    .collect();
  const used = await store.note(db, fakeEmbedder, 'knowledge', {
    content: 'the eclipse on tuesday was striking',
    derived_by: 'manual',
  });
  const unused = await store.note(db, fakeEmbedder, 'knowledge', {
    content: 'tomatoes need calcium spray',
    derived_by: 'manual',
  });

  const pastTs = new Date(Date.now() - 10 * 60 * 1000);
  const replyTs = new Date(pastTs.getTime() + 60_000);
  await db
    .query(
      `CREATE events CONTENT {
         source: 'conversation',
         content: 'USER: did you see it?\n\nASSISTANT: yeah the eclipse on tuesday was striking and memorable.',
         ts: $ts,
         meta: { session_id: 'sess-1' }
       }`,
      { ts: replyTs },
    )
    .collect();
  await db
    .query(
      `CREATE recall_log CONTENT {
         ts: $ts, session_id: 'sess-1', query: 'eclipse', k: 2,
         ranked_hits: [
           { record: $a, kind: 'memo', rank: 0 },
           { record: $b, kind: 'memo', rank: 1 }
         ],
         outcome: 'pending'
       }`,
      { ts: pastTs, a: String(used.id), b: String(unused.id) },
    )
    .collect();

  const summary = await evaluatePending(db);
  assert.equal(summary.reinforced, 1);

  const [usedRow] = await db.query(`SELECT signal_count FROM ${used.id}`).collect();
  const [unusedRow] = await db.query(`SELECT signal_count FROM ${unused.id}`).collect();
  // DEFAULT signal_count=1 (0001-init); used memo bumps by 1; unused unchanged.
  assert.equal(usedRow[0].signal_count, 2, 'used memo gets += 1');
  assert.equal(unusedRow[0].signal_count, 1, 'unused memo NOT bumped');

  const [ledger] = await db
    .query(`SELECT memo_id, polarity, weight FROM evidence_ledger`)
    .collect();
  const usedLedger = ledger.filter((r) => String(r.memo_id) === String(used.id));
  const unusedLedger = ledger.filter((r) => String(r.memo_id) === String(unused.id));
  assert.equal(usedLedger.length, 1);
  assert.equal(usedLedger[0].polarity, 'corroborates');
  assert.equal(unusedLedger.length, 0);
  await close(db);
});

test('B1: zero used + fallback_when_zero_used=false -> outcome evaluated_no_used, no bump', async () => {
  const db = await fresh();
  await db
    .query(
      "UPDATE runtime:`reinforcement.config` SET value.attribution_mode = 'hybrid', value.fallback_when_zero_used = false",
    )
    .collect();
  const m = await store.note(db, fakeEmbedder, 'knowledge', {
    content: 'the eclipse on tuesday',
    derived_by: 'manual',
  });
  const pastTs = new Date(Date.now() - 10 * 60 * 1000);
  const replyTs = new Date(pastTs.getTime() + 60_000);
  await db
    .query(
      `CREATE events CONTENT {
         source: 'conversation',
         content: 'USER: hi\n\nASSISTANT: cool nothing matches.',
         ts: $ts,
         meta: { session_id: 'sess-z' }
       }`,
      { ts: replyTs },
    )
    .collect();
  await db
    .query(
      `CREATE recall_log CONTENT {
         ts: $ts, session_id: 'sess-z', query: 'q', k: 1,
         ranked_hits: [{ record: $rid, kind: 'memo', rank: 0 }],
         outcome: 'pending'
       }`,
      { ts: pastTs, rid: String(m.id) },
    )
    .collect();

  const summary = await evaluatePending(db);
  assert.equal(summary.evaluated, 1);
  const [rows] = await db.query('SELECT outcome FROM recall_log').collect();
  assert.equal(rows[0].outcome, 'evaluated_no_used');
  const [after] = await db.query(`SELECT signal_count FROM ${m.id}`).collect();
  assert.equal(after[0].signal_count, 1, 'no bump when all hits used=false (DEFAULT 1)');
  await close(db);
});

test('B1: per-row attribution + reply_event_id are persisted', async () => {
  const db = await fresh();
  await db
    .query("UPDATE runtime:`reinforcement.config` SET value.attribution_mode = 'hybrid'")
    .collect();
  const m = await store.note(db, fakeEmbedder, 'knowledge', {
    content: 'the eclipse on tuesday was striking',
    derived_by: 'manual',
  });
  const pastTs = new Date(Date.now() - 10 * 60 * 1000);
  const replyTs = new Date(pastTs.getTime() + 60_000);
  const [evtCreated] = await db
    .query(
      `CREATE events CONTENT {
         source: 'conversation',
         content: 'USER: q\n\nASSISTANT: yeah the eclipse on tuesday was striking and lovely.',
         ts: $ts,
         meta: { session_id: 'sess-p' }
       }`,
      { ts: replyTs },
    )
    .collect();
  const replyEventId = (Array.isArray(evtCreated) ? evtCreated[0] : evtCreated).id;
  await db
    .query(
      `CREATE recall_log CONTENT {
         ts: $ts, session_id: 'sess-p', query: 'eclipse', k: 1,
         ranked_hits: [{ record: $rid, kind: 'memo', rank: 0 }],
         outcome: 'pending'
       }`,
      { ts: pastTs, rid: String(m.id) },
    )
    .collect();

  await evaluatePending(db);
  const [rows] = await db
    .query('SELECT ranked_hits, attribution, reply_event_id FROM recall_log')
    .collect();
  const row = rows[0];
  assert.equal(String(row.reply_event_id), String(replyEventId));
  // Full §1 attribution shape — every field present, none undefined.
  const a = row.attribution;
  assert.equal(a.mode, 'similarity');
  assert.equal(a.used_count, 1);
  assert.equal(a.total, 1);
  assert.equal(a.similarity_threshold, 0.35);
  assert.equal(a.jaccard_min_overlap_tokens, 2);
  assert.equal(a.dropped_hits, 0);
  assert.equal(typeof a.elapsed_ms, 'number');
  assert.ok(a.elapsed_ms >= 0);
  assert.equal(row.ranked_hits[0].used, true);
  assert.equal(row.ranked_hits[0].used_via, 'similarity');
  assert.ok(row.ranked_hits[0].used_score >= 0.35);
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
