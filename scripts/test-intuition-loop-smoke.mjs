#!/usr/bin/env node
// End-to-end: intuition → recall_log → reinforcement → memo signal_count++.
// This is the keystone effectiveness pathway; if it works, the whole loop works.

import { readFileSync } from 'node:fs';
import { createNodeEngines } from '@surrealdb/node';
import { Surreal } from 'surrealdb';

const ROOT = '/Users/iser/workspace/robin/robin-assistant-v2-worktrees/redesign';

const db = new Surreal({ engines: createNodeEngines() });
await db.connect('mem://');
await db.use({ namespace: 'test', database: 'main' });

for (const f of ['0001-init.surql', '0002-embeddings-mxbai-1024.surql']) {
  const sql = readFileSync(`${ROOT}/src/schema/migrations/${f}`, 'utf8');
  await db.query(`BEGIN TRANSACTION;\n${sql}\n;\nCOMMIT TRANSACTION;`).collect();
}

const store = await import(`${ROOT}/src/memory/store.js`);
const { intuitionEndpoint } = await import(`${ROOT}/src/recall/intuition.js`);
const { evaluatePending } = await import(`${ROOT}/src/recall/reinforcement.js`);

// Mock embedder: deterministic-ish, just needs the right dim
const mockEmbedder = {
  embed: async (text) => {
    const v = new Float32Array(1024);
    let h = 0;
    for (let i = 0; i < (text ?? '').length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
    for (let i = 0; i < 1024; i++) v[i] = ((h >> (i % 31)) & 1) / 1024;
    return v;
  },
};

// Seed: write a knowledge memo about Kevin
const memo1 = await store.note(db, mockEmbedder, 'knowledge', {
  content: 'Kevin prefers terse responses and dislikes long preambles.',
  derived_by: 'manual',
  confidence: 0.8,
});
console.log('seeded memo:', String(memo1.id));

// Read initial signal_count
const [r1] = await db.query(`SELECT signal_count FROM ${memo1.id}`).collect();
console.log('initial signal_count:', r1[0].signal_count);

// Trigger intuition. Should fetch the knowledge memo.
const result = await intuitionEndpoint({
  db,
  embedder: mockEmbedder,
  query: 'Kevin terse',
  k: 3,
  recencyDays: 30,
});
console.log('intuition hits:', result.hits, 'tokens:', result.tokens);

// Inspect recall_log to confirm the memo was logged
const [logs] = await db.query('SELECT id, ranked_hits, outcome FROM recall_log').collect();
console.log('recall_log rows:', logs.length);
const intuitionHit = logs[0]?.ranked_hits?.[0];
console.log('ranked_hits[0]:', JSON.stringify(intuitionHit));

// The recall_log row written by intuition has ts=now, which the reinforcement
// loop won't evaluate yet (it waits 5 min). For the smoke test, insert a
// SECOND recall_log row dated 10 minutes ago carrying the same memo, then
// run the evaluator on it. This proves the path memo→recall_log→reinforce works.
const pastTs = new Date(Date.now() - 10 * 60 * 1000);
await db
  .query(
    `CREATE recall_log CONTENT {
      ts: $ts, query: 'backdated', k: 1, ranked_hits: $hits,
      outcome: 'pending', session_id: 'smoke'
    }`,
    { ts: pastTs, hits: [{ memo_id: String(memo1.id), kind: 'memo', rank: 0 }] },
  )
  .collect();

// Evaluate
const summary = await evaluatePending(db);
console.log('reinforcement summary:', summary);

// signal_count should have bumped (because the recall_log row carried a memo hit)
const [r2] = await db.query(`SELECT signal_count FROM ${memo1.id}`).collect();
console.log('post-reinforcement signal_count:', r2[0].signal_count);

await db.close();

if (r2[0].signal_count > r1[0].signal_count && summary.reinforced > 0) {
  console.log('\nIntuition→reinforcement loop PASSED');
  process.exit(0);
} else {
  console.error('\nLoop FAILED: memo was not reinforced');
  console.error('  expected signal_count > 1; got', r2[0].signal_count);
  console.error('  expected reinforced > 0; got', summary.reinforced);
  process.exit(1);
}
