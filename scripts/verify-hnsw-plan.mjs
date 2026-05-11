#!/usr/bin/env node
// Verify the HNSW index is actually being selected by the planner for our
// recall queries, not falling back to a brute-force scan.

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

// Seed a handful of memos + embeddings
const store = await import(`${ROOT}/src/memory/store.js`);
const mockEmbedder = {
  embed: async (text) => {
    const v = new Float32Array(1024);
    let h = 0;
    for (let i = 0; i < (text ?? '').length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
    for (let i = 0; i < 1024; i++) v[i] = ((h >> (i % 31)) & 1) / 1024;
    return v;
  },
};

for (let i = 0; i < 20; i++) {
  await store.note(db, mockEmbedder, 'knowledge', {
    content: `Fact number ${i} about Kevin's preferences`,
    derived_by: 'manual',
  });
}

// EXPLAIN the HNSW query
const qvec = Array.from(await mockEmbedder.embed('Kevin preferences'));
const [explain] = await db
  .query(
    `SELECT record, vector::distance::knn() AS dist
     FROM embeddings_mxbai_1024_memos
     WHERE vector <|10, 64|> $q
     ORDER BY dist
     LIMIT 10
     EXPLAIN FULL`,
    { q: qvec },
  )
  .collect();

console.log('EXPLAIN FULL output:');
console.log(JSON.stringify(explain, null, 2));

const planText = JSON.stringify(explain);
if (planText.toLowerCase().includes('hnsw') || planText.toLowerCase().includes('knn')) {
  console.log('\n✓ HNSW / kNN appears in the plan');
} else {
  console.error('\n✗ HNSW NOT in plan — query is doing a brute-force scan');
  process.exit(1);
}
process.exit(0);
