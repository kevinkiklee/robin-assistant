#!/usr/bin/env node
// Smoke test: load all new Wave 1 modules, exercise basic store primitives
// against a fresh in-memory DB with the new 0001 + 0002-mxbai migrations.

import { readFileSync } from 'node:fs';
import { createNodeEngines } from '@surrealdb/node';
import { Surreal } from 'surrealdb';

const ROOT = '/Users/iser/workspace/robin/robin-assistant-v2-worktrees/redesign';

// --- 1. Load modules
console.log('loading modules...');
const decay = await import(`${ROOT}/src/memory/decay.js`);
const scopes = await import(`${ROOT}/src/memory/scopes.js`);
const kindReg = await import(`${ROOT}/src/memory/kind-registry.js`);
const edgeReg = await import(`${ROOT}/src/memory/edge-registry.js`);
const profileRouter = await import(`${ROOT}/src/embed/profile-router.js`);
const store = await import(`${ROOT}/src/memory/store.js`);
console.log('  all modules loaded');

// --- 2. Constants sanity
console.log('\nconstants:');
console.log('  SCOPE.GLOBAL =', scopes.SCOPE.GLOBAL);
console.log('  SCOPE.project("X") =', scopes.SCOPE.project('X'));
console.log('  isEphemeralScope("session:abc") =', scopes.isEphemeralScope('session:abc'));
console.log('  isEphemeralScope("global") =', scopes.isEphemeralScope('global'));

// --- 3. Registry validation
console.log('\nregistry validation:');
const v1 = kindReg.validateMemoKind('habit', {
  content: 'X',
  derived_by: 'dream',
  meta: { name: 'rt' },
});
console.log('  valid habit memo:', v1);
const v2 = kindReg.validateMemoKind('habit', { content: 'X', derived_by: 'dream', meta: {} });
console.log('  invalid habit (no name):', v2);
const v3 = edgeReg.validateEdge(
  { tb: 'events', id: 'e1' },
  { tb: 'entities', id: 'a' },
  'mentions',
);
console.log('  valid edge events→entities mentions:', v3);
const v4 = edgeReg.validateEdge({ tb: 'memos', id: 'm1' }, { tb: 'events', id: 'e1' }, 'mentions');
console.log('  invalid edge memos→events mentions:', v4);
const v5 = edgeReg.validateEdge(
  { tb: 'entities', id: 'a' },
  { tb: 'entities', id: 'a' },
  'occurs_with',
);
console.log('  self-loop rejected:', v5);

// --- 4. Decay
console.log('\ndecay:');
const fresh = decay.freshness({
  kind: 'knowledge',
  confidence: 0.8,
  signal_count: 3,
  decay_anchor: new Date(),
});
console.log('  freshness(new knowledge, 3 signals) =', fresh.toFixed(3));
const superseded = decay.freshness({ kind: 'knowledge', confidence: 0.9 }, { supersededCount: 1 });
console.log('  freshness(superseded) =', superseded);

// --- 5. End-to-end: spin up DB, apply migrations, write through store.
console.log('\ne2e store + DB:');
const db = new Surreal({ engines: createNodeEngines() });
await db.connect('mem://');
await db.use({ namespace: 'test', database: 'main' });

for (const f of ['0001-init.surql', '0002-embeddings-mxbai-1024.surql']) {
  const sql = readFileSync(`${ROOT}/src/schema/migrations/${f}`, 'utf8');
  await db.query(`BEGIN TRANSACTION;\n${sql}\n;\nCOMMIT TRANSACTION;`).collect();
}
console.log('  migrations applied');

// Mock embedder (1024-dim zeros so the constraint holds without loading a model)
const mockEmbedder = {
  embed: async (_text) => new Float32Array(1024),
};

const memo1 = await store.note(db, mockEmbedder, 'knowledge', {
  content: 'The user prefers terse responses',
  derived_by: 'dream',
  confidence: 0.85,
});
console.log('  note(knowledge) →', memo1.id);

const memo2 = await store.note(db, mockEmbedder, 'knowledge', {
  content: 'The user prefers terse responses', // duplicate content → dedup
  derived_by: 'dream',
});
console.log(
  '  note(knowledge, dup) → deduped:',
  memo2.deduped,
  'same id:',
  String(memo1.id) === String(memo2.id),
);

const habit1 = await store.upsertMemoByName(db, mockEmbedder, 'habit', {
  name: 'morning-coffee',
  content: 'Has coffee at 8am',
  derived_by: 'dream',
});
console.log('  upsertMemoByName(habit, morning-coffee) →', habit1.id);

const habit2 = await store.upsertMemoByName(db, mockEmbedder, 'habit', {
  name: 'morning-coffee',
  content: 'Has coffee at 8am',
  derived_by: 'dream',
});
console.log('  re-upsert same habit → signal_increment:', habit2.signal_increment);

// Read back: signal_count should be 2 now
const [habitRows] = await db.query(`SELECT signal_count FROM ${habit1.id}`).collect();
console.log('  signal_count after re-upsert:', habitRows[0].signal_count);

// Create entities and connect
const ent1 = await db.query(`CREATE entities CONTENT { name: 'Kevin', type: 'person' }`).collect();
const ent1Id = ent1[0][0].id;
const ent2 = await db.query(`CREATE entities CONTENT { name: 'Robin', type: 'project' }`).collect();
const ent2Id = ent2[0][0].id;

// Add some occurs_with edges (counter)
await store.relate(db, ent1Id, ent2Id, 'occurs_with');
await store.relate(db, ent1Id, ent2Id, 'occurs_with'); // increment
await store.relate(db, ent2Id, ent1Id, 'occurs_with'); // canonical → same edge → +1 more
const [coOcc] = await db.query(`SELECT weight FROM edges WHERE kind = 'occurs_with'`).collect();
console.log('  occurs_with count after 3 relate calls:', coOcc[0]?.weight);

// Supersede memo1 with a new fact
const memo3 = await store.note(db, mockEmbedder, 'knowledge', {
  content: 'The user prefers balanced responses (correction)',
  derived_by: 'dream',
  confidence: 0.95,
});
await store.supersede(db, memo1.id, memo3.id);
const memo1Fresh = await db.query(`RETURN fn::freshness(${memo1.id})`).collect();
console.log('  fn::freshness(superseded memo1) =', memo1Fresh[0]?.[0] ?? memo1Fresh[0]);

const memo3Fresh = await db.query(`RETURN fn::freshness(${memo3.id})`).collect();
console.log('  fn::freshness(memo3) =', memo3Fresh[0]?.[0] ?? memo3Fresh[0]);

await db.close();
console.log('\nSmoke test passed.');
process.exit(0);
