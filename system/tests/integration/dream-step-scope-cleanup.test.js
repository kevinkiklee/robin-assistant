// Verifies dreamStepScopeCleanup promotes referenced ephemeral memos to
// global scope and prunes orphaned ones past TTL. Promoted from
// scripts/test-scope-cleanup-smoke.mjs so regressions fail CI.

import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import { test } from 'node:test';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { dreamStepScopeCleanup } from '../../src/dream/step-scope-cleanup.js';
import * as store from '../../src/memory/store.js';
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

// derived_at is READONLY-with-default — for "past TTL" rows we override it at
// CREATE time via direct SurrealQL rather than going through store.note.
async function seedBackdated(db, scope, content) {
  const past = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000); // 8 days ago
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

test('scope cleanup: prunes orphan past TTL, promotes referenced, keeps fresh', async () => {
  const db = await fresh();

  const A = await seedBackdated(db, 'session:abc', 'ephemeral-A (orphan, past TTL)');
  const B_ephemeral = await seedBackdated(db, 'session:abc', 'ephemeral-B (referenced, past TTL)');
  const B_global = await store.note(db, fakeEmbedder, 'knowledge', {
    content: 'global-B (derives from ephemeral-B)',
    derived_by: 'dream',
    scope: 'global',
    lineage: [{ id: B_ephemeral.id, kind: 'memo' }],
  });
  const C = await store.note(db, fakeEmbedder, 'knowledge', {
    content: 'ephemeral-C (fresh)',
    derived_by: 'dream',
    scope: 'session:abc',
  });

  const summary = await dreamStepScopeCleanup(db, null);
  assert.ok(summary, 'returns a summary');

  const [rows] = await db.query('SELECT id, scope FROM memos').collect();
  const find = (id) => rows.find((r) => String(r.id) === String(id));

  assert.equal(find(A.id), undefined, 'orphan past TTL pruned');
  assert.equal(find(B_ephemeral.id)?.scope, 'global', 'referenced ephemeral promoted');
  assert.ok(find(C.id), 'fresh ephemeral kept');
  assert.ok(find(B_global.id), 'global memo kept');

  await close(db);
});
