// Verifies relateAll retries transient SurrealDB "Transaction conflict"
// errors on each slice rather than skipping the slice on first failure.
// Regression: pre-fix, a single conflict on a 50-edge slice dropped all
// 50 edges silently — observable in daemon.log as
// "relateAll: slice [0..25] failed, skipping 26 edges: ... Transaction conflict".

import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { relateAll } from '../../cognition/memory/store.js';
import { writeConfig as __robinWriteConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';

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

async function seedEntities(db) {
  const [a] = await db
    .query(
      surql`UPSERT type::record('entities', 'person__a') CONTENT ${{
        name: 'A',
        name_lower: 'a',
        type: 'person',
      }}`,
    )
    .collect();
  const [b] = await db
    .query(
      surql`UPSERT type::record('entities', 'thing__b') CONTENT ${{
        name: 'B',
        name_lower: 'b',
        type: 'thing',
      }}`,
    )
    .collect();
  const aId = (Array.isArray(a) ? a[0] : a).id;
  const bId = (Array.isArray(b) ? b[0] : b).id;
  return { aId, bId };
}

// Proxy a Surreal-like db so we can intercept just relateAll's BEGIN/COMMIT
// query and inject a transient conflict on the first attempt. All other
// queries pass through to the real db.
function makeFlakyDb(realDb, { conflictsBeforeSuccess }) {
  let injected = 0;
  return {
    query(arg) {
      const inner = realDb.query(arg);
      return {
        collect: async () => {
          // BoundQuery exposes the SQL via its `query` getter.
          const raw = arg?.query;
          const sql = typeof raw === 'string' ? raw : typeof arg === 'string' ? arg : '';
          const isRelateBatch =
            sql.includes('INSERT RELATION INTO edges') && sql.includes('BEGIN TRANSACTION');
          if (isRelateBatch && injected < conflictsBeforeSuccess) {
            injected += 1;
            throw new Error('Transaction conflict: Write conflict (injected)');
          }
          return await inner.collect();
        },
      };
    },
  };
}

test('relateAll retries a transient transaction conflict and succeeds', async () => {
  const real = await fresh();
  const { aId, bId } = await seedEntities(real);
  const flaky = makeFlakyDb(real, { conflictsBeforeSuccess: 1 });
  // Single edge — the slice will fail once, then succeed on retry.
  const r = await relateAll(flaky, [{ from: aId, to: bId, kind: 'occurs_with' }]);
  assert.equal(r.ids.length, 1);
  // Verify the edge actually landed (occurs_with is symmetric; canonical
  // ordering may flip the in/out, so query by kind only).
  const [rows] = await real.query(surql`SELECT * FROM edges WHERE kind = 'occurs_with'`).collect();
  assert.equal(rows.length, 1);
  await close(real);
});

test('relateAll gives up after exhausting retries on persistent conflict', async () => {
  const real = await fresh();
  const { aId, bId } = await seedEntities(real);
  // 10 conflicts in a row — well above the retry cap (2). Slice gets skipped.
  const flaky = makeFlakyDb(real, { conflictsBeforeSuccess: 10 });
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (m) => warnings.push(m);
  try {
    const r = await relateAll(flaky, [{ from: aId, to: bId, kind: 'occurs_with' }]);
    assert.equal(r.ids.length, 0);
  } finally {
    console.warn = origWarn;
  }
  assert.ok(
    warnings.some((w) => /retried, still conflict/.test(w)),
    'expected "retried, still conflict" warning',
  );
  await close(real);
});

// Note: non-conflict-error skip-without-retry is enforced structurally by
// `if (!isTxConflict(e)) break;` in store.js relateAll. The retry test above
// already proves the conflict path; the non-conflict path is a single branch
// that doesn't warrant a separate proxy test.
