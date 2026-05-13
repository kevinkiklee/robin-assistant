// Verifies the recall-reinforcement loop, the "keystone effectiveness fix"
// (see docs/archive/HANDOFF-v2-migration.md). Promoted from
// scripts/test-reinforcement-smoke.mjs so regressions in this loop fail CI.

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

test('B1 §8.2 #16: episode-tagged memo + [episode YYYY-MM-DD] reply → attribution.mode=citation', async () => {
  const db = await fresh();
  await db
    .query("UPDATE runtime:`reinforcement.config` SET value.attribution_mode = 'hybrid'")
    .collect();
  // Memo with meta.kind='episode_summary' is the ONLY shape that
  // produces an [episode ...] citation line in inject.js:formatHit, and
  // the only shape that attribute()'s citation pass will accept for the
  // 'episode' keyword.
  // memos.derived_at is READONLY DEFAULT time::now(); the citation pass
  // tolerates the resulting "today" timestamp because we use a +/-2 day
  // window. We craft the reply citation to match today's date for stability.
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const [memoCreate] = await db
    .query(
      `CREATE memos CONTENT {
         kind: 'knowledge',
         content: 'team off-site retro: shipping calendar reset',
         derived_by: 'manual',
         signal_count: 1,
         meta: { kind: 'episode_summary' }
       }`,
    )
    .collect();
  const memoId = (Array.isArray(memoCreate) ? memoCreate[0] : memoCreate).id;

  const pastTs = new Date(Date.now() - 10 * 60 * 1000);
  await db
    .query(
      `CREATE events CONTENT {
         source: 'conversation',
         content: $content,
         ts: $ts,
         meta: { session_id: 'sess-ep' }
       }`,
      {
        content: `USER: q\n\nASSISTANT: see [episode ${todayStr}] for the shipping context.`,
        ts: new Date(pastTs.getTime() + 60_000),
      },
    )
    .collect();
  await db
    .query(
      `CREATE recall_log CONTENT {
         ts: $ts, session_id: 'sess-ep', query: 'q', k: 1,
         ranked_hits: [{ record: $rid, kind: 'memo', rank: 0 }],
         outcome: 'pending'
       }`,
      { ts: pastTs, rid: String(memoId) },
    )
    .collect();

  const summary = await evaluatePending(db);
  assert.equal(summary.reinforced, 1);

  const [rows] = await db.query('SELECT ranked_hits, attribution FROM recall_log').collect();
  assert.equal(rows[0].attribution.mode, 'citation');
  assert.equal(rows[0].ranked_hits[0].used, true);
  assert.equal(rows[0].ranked_hits[0].used_via, 'citation');

  const [after] = await db.query(`SELECT signal_count FROM ${memoId}`).collect();
  assert.equal(after[0].signal_count, 2, 'episode memo bumped by 1');

  const [ledger] = await db
    .query('SELECT polarity, weight FROM evidence_ledger WHERE memo_id = $id', { id: memoId })
    .collect();
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].polarity, 'corroborates');
  assert.equal(ledger[0].weight, 1);

  await close(db);
});

test('B1 section 6: corroborate weight reflects per-hit used count, not row count', async () => {
  const db = await fresh();
  await db
    .query("UPDATE runtime:`reinforcement.config` SET value.attribution_mode = 'hybrid'")
    .collect();
  const m = await store.note(db, fakeEmbedder, 'knowledge', {
    content: 'eclipse tuesday striking',
    derived_by: 'manual',
  });
  const pastTs = new Date(Date.now() - 10 * 60 * 1000);
  // Two pending rows for the SAME memo, in two sessions; each session has its
  // own reply event whose body matches via similarity.
  for (const sid of ['s1', 's2']) {
    await db
      .query(
        `CREATE events CONTENT {
           source: 'conversation',
           content: 'USER: q\n\nASSISTANT: eclipse tuesday striking observation here.',
           ts: $ts,
           meta: { session_id: $sid }
         }`,
        { ts: new Date(pastTs.getTime() + 60_000), sid },
      )
      .collect();
    await db
      .query(
        `CREATE recall_log CONTENT {
           ts: $ts, session_id: $sid, query: 'q', k: 1,
           ranked_hits: [{ record: $rid, kind: 'memo', rank: 0 }],
           outcome: 'pending'
         }`,
        { ts: pastTs, sid, rid: String(m.id) },
      )
      .collect();
  }
  await evaluatePending(db);
  const [ledger] = await db
    .query('SELECT polarity, weight FROM evidence_ledger WHERE memo_id = $id', { id: m.id })
    .collect();
  assert.equal(ledger.length, 1, 'one corroborate row for the memo');
  assert.equal(ledger[0].polarity, 'corroborates');
  assert.equal(ledger[0].weight, 2, 'weight=2 (used in both rows)');
  await close(db);
});

test('B1 §7.10: duplicate hit in ranked_hits dedups in memoHitCount → signal_count bumps by 1, not 2', async () => {
  const db = await fresh();
  await db
    .query("UPDATE runtime:`reinforcement.config` SET value.attribution_mode = 'hybrid'")
    .collect();
  const m = await store.note(db, fakeEmbedder, 'knowledge', {
    content: 'sourdough hydration ratio sixty percent',
    derived_by: 'manual',
  });
  const pastTs = new Date(Date.now() - 10 * 60 * 1000);
  await db
    .query(
      `CREATE events CONTENT {
         source: 'conversation',
         content: 'USER: q\n\nASSISTANT: yes the sourdough hydration ratio sixty percent is right.',
         ts: $ts,
         meta: { session_id: 'sess-dup' }
       }`,
      { ts: new Date(pastTs.getTime() + 60_000) },
    )
    .collect();
  // Same memo appears twice in ranked_hits — possible via the MCP recall.js path.
  await db
    .query(
      `CREATE recall_log CONTENT {
         ts: $ts, session_id: 'sess-dup', query: 'q', k: 2,
         ranked_hits: [
           { record: $rid, kind: 'memo', rank: 0 },
           { record: $rid, kind: 'memo', rank: 1 }
         ],
         outcome: 'pending'
       }`,
      { ts: pastTs, rid: String(m.id) },
    )
    .collect();
  await evaluatePending(db);
  const [after] = await db.query(`SELECT signal_count FROM ${m.id}`).collect();
  // Initial signal_count is 1 (from store.note default). Memo appears in 1
  // pending row, regardless of the duplicate within ranked_hits, so the
  // bump is +1, not +2 -> 2 total.
  assert.equal(after[0].signal_count, 1 + 1, 'duplicate ranked_hits collapsed by memoHitCount');
  await close(db);
});

test('B1 section 10: explain_recall surfaces used/used_via/attribution/reply_event_id', async () => {
  const db = await fresh();
  await db
    .query("UPDATE runtime:`reinforcement.config` SET value.attribution_mode = 'hybrid'")
    .collect();
  const m = await store.note(db, fakeEmbedder, 'knowledge', {
    content: 'eclipse tuesday striking',
    derived_by: 'manual',
  });
  const pastTs = new Date(Date.now() - 10 * 60 * 1000);
  await db
    .query(
      `CREATE events CONTENT {
         source: 'conversation',
         content: 'USER: q\n\nASSISTANT: eclipse tuesday striking observation.',
         ts: $ts,
         meta: { session_id: 'sx' }
       }`,
      { ts: new Date(pastTs.getTime() + 60_000) },
    )
    .collect();
  await db
    .query(
      `CREATE recall_log CONTENT {
         ts: $ts, session_id: 'sx', query: 'q', k: 1,
         ranked_hits: [{ record: $rid, kind: 'memo', rank: 0 }],
         outcome: 'pending'
       }`,
      { ts: pastTs, rid: String(m.id) },
    )
    .collect();
  await evaluatePending(db);

  const { createExplainRecallTool } = await import('../../io/mcp/tools/explain-recall.js');
  const tool = createExplainRecallTool({ db });
  const out = await tool.handler({ last_n: 1 });
  const q = out.queries[0];
  assert.equal(q.attribution.mode, 'similarity');
  assert.equal(q.ranked_hits[0].used, true);
  assert.equal(q.ranked_hits[0].used_via, 'similarity');
  assert.ok(q.reply_event_id);
  await close(db);
});

test('B1: pre-B1 recall_log rows (no used field) work under mode=off', async () => {
  const db = await fresh();
  // Migration 0021 (cognition-wave-enable) flipped attribution_mode to
  // 'hybrid'; this test asserts pre-B1 mode=off behavior, so set explicitly.
  await db
    .query("UPSERT runtime:`reinforcement.config` SET value.attribution_mode = 'off'")
    .collect();
  const m = await store.note(db, fakeEmbedder, 'knowledge', {
    content: 'pre-B1 row',
    derived_by: 'manual',
  });
  const pastTs = new Date(Date.now() - 10 * 60 * 1000);
  // Recall_log row WITHOUT the new used/used_via keys (the old shape).
  await db
    .query(
      `CREATE recall_log CONTENT {
         ts: $ts, session_id: 's', query: 'q', k: 1,
         ranked_hits: [{ record: $rid, kind: 'memo', rank: 0 }],
         outcome: 'pending'
       }`,
      { ts: pastTs, rid: String(m.id) },
    )
    .collect();
  const summary = await evaluatePending(db);
  assert.equal(summary.reinforced, 1, 'mode=off treats every memo hit as used (legacy)');
  const [after] = await db.query(`SELECT signal_count FROM ${m.id}`).collect();
  // DEFAULT signal_count=1 + 1 bump = 2.
  assert.equal(after[0].signal_count, 2);
  const [rows] = await db.query('SELECT attribution FROM recall_log').collect();
  assert.equal(rows[0].attribution.mode, 'off');
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
