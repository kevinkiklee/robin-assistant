#!/usr/bin/env node
// Smoke: step-scope-cleanup promotes referenced ephemerals; prunes stale ones.

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
const { dreamStepScopeCleanup } = await import(`${ROOT}/src/dream/step-scope-cleanup.js`);
const mockEmbedder = { embed: async () => new Float32Array(1024) };

// Seed:
//   A) ephemeral memo with no inbound refs → should be PRUNED (after TTL)
//   B) ephemeral memo with a global memo that derived_from it → should be PROMOTED
//   C) fresh ephemeral memo (within TTL) with no refs → kept (not yet expired)
//
// derived_at is READONLY-with-default — to make A and B count as "past 7d",
// we override derived_at at CREATE time via direct SurrealQL (not store.note).

const past = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000); // 8 days ago

async function seedBackdated(scope, content) {
  const [r] = await db
    .query(
      `CREATE memos CONTENT {
        kind: 'knowledge', content: $c, content_hash: $h,
        derived_by: 'manual', scope: $s,
        derived_at: $t, last_active: $t, decay_anchor: $t
      }`,
      { c: content, h: `h-${content}`, s: scope, t: past },
    )
    .collect();
  return r[0];
}

async function seedNow(scope, content, lineageMemoId) {
  return store.note(db, mockEmbedder, 'knowledge', {
    content,
    derived_by: 'dream',
    scope,
    ...(lineageMemoId ? { lineage: [{ id: lineageMemoId, kind: 'memo' }] } : {}),
  });
}

const A = await seedBackdated('session:abc', 'ephemeral-A (orphan, past TTL)');
const B_ephemeral = await seedBackdated('session:abc', 'ephemeral-B (referenced, past TTL)');
const B_global = await seedNow('global', 'global-B (derives from ephemeral-B)', B_ephemeral.id);
const C = await seedNow('session:abc', 'ephemeral-C (fresh)');

const summary = await dreamStepScopeCleanup(db, null);
console.log('cleanup summary:', summary);

// Inspect final state
const [rows] = await db.query('SELECT id, content, scope FROM memos ORDER BY id').collect();
console.log('final memos:');
for (const r of rows) console.log(' ', String(r.id), r.scope, '-', r.content);

const aGone = !rows.find((r) => String(r.id) === String(A.id));
const bEphemPromoted =
  rows.find((r) => String(r.id) === String(B_ephemeral.id))?.scope === 'global';
const cKept = !!rows.find((r) => String(r.id) === String(C.id));
const bGlobalKept = !!rows.find((r) => String(r.id) === String(B_global.id));

await db.close();

if (aGone && bEphemPromoted && cKept && bGlobalKept) {
  console.log('\nScope cleanup smoke PASSED');
  process.exit(0);
}
console.error('\nFAIL', { aGone, bEphemPromoted, cKept, bGlobalKept });
process.exit(1);
