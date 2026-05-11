#!/usr/bin/env node
// Smoke: write a recall_log row in the past, run reinforcement evaluator,
// verify signal_count++ on referenced memos when no correction landed.

import { readFileSync } from 'node:fs';
import { createNodeEngines } from '@surrealdb/node';
import { Surreal } from 'surrealdb';

const ROOT = '/Users/iser/workspace/robin/robin-assistant-v2';

const db = new Surreal({ engines: createNodeEngines() });
await db.connect('mem://');
await db.use({ namespace: 'test', database: 'main' });

for (const f of ['0001-init.surql', '0002-embeddings-mxbai-1024.surql']) {
  const sql = readFileSync(`${ROOT}/src/schema/migrations/${f}`, 'utf8');
  await db.query(`BEGIN TRANSACTION;\n${sql}\n;\nCOMMIT TRANSACTION;`).collect();
}

const store = await import(`${ROOT}/src/memory/store.js`);
const { evaluatePending, REINFORCE_WINDOW_MS } = await import(
  `${ROOT}/src/recall/reinforcement.js`
);

const mockEmbedder = { embed: async () => new Float32Array(1024) };

// Create a memo
const m = await store.note(db, mockEmbedder, 'knowledge', {
  content: 'Test fact for reinforcement',
  derived_by: 'manual',
});
console.log('memo id:', String(m.id));

// Read initial signal_count
const [r1] = await db.query(`SELECT signal_count FROM ${m.id}`).collect();
console.log('initial signal_count:', r1[0].signal_count);

// Insert a recall_log row dated 10 minutes ago, status pending, with this memo as a hit
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

// Run evaluator
const summary = await evaluatePending(db);
console.log('evaluator summary:', summary);

// Read signal_count again — should be 2 (originally 1, reinforced once)
const [r2] = await db.query(`SELECT signal_count, decay_anchor FROM ${m.id}`).collect();
console.log('after reinforcement signal_count:', r2[0].signal_count, 'anchor:', r2[0].decay_anchor);

// Verify recall_log row was updated
const [logs] = await db.query('SELECT outcome FROM recall_log').collect();
console.log(
  'recall_log outcomes:',
  logs.map((l) => l.outcome),
);

// Now test the correction path: insert another recall_log + a correction event in the same window
const pastTs2 = new Date(Date.now() - 10 * 60 * 1000);
await db
  .query(
    `CREATE recall_log CONTENT {
      ts: $ts, session_id: 'session-corrected', query: 'q2',
      k: 1, ranked_hits: $hits, outcome: 'pending'
    }`,
    { ts: pastTs2, hits: [{ memo_id: m.id, rank: 0 }] },
  )
  .collect();
// Insert a correction event in the window for session-corrected
await db
  .query(
    `CREATE events CONTENT {
      source: 'manual',
      content: 'no, that was wrong',
      ts: $ts,
      meta: { kind: 'correction', session_id: 'session-corrected' }
    }`,
    { ts: new Date(pastTs2.getTime() + 60_000) },
  )
  .collect();

// Evaluate
const summary2 = await evaluatePending(db);
console.log('second evaluator summary:', summary2);

// signal_count should NOT have been bumped this time
const [r3] = await db.query(`SELECT signal_count FROM ${m.id}`).collect();
console.log('signal_count after correction path (expect same as before):', r3[0].signal_count);

await db.close();

if (
  r2[0].signal_count === 2 &&
  r3[0].signal_count === 2 &&
  summary.reinforced === 1 &&
  summary2.corrected === 1
) {
  console.log('\nReinforcement smoke test PASSED');
  process.exit(0);
} else {
  console.error('\nReinforcement smoke test FAILED');
  process.exit(1);
}
