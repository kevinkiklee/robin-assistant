import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import { test } from 'node:test';
import { fetchContradictors } from '../../cognition/intuition/conflicts.js';
import * as store from '../../cognition/memory/store.js';
import { writeConfig as __robinWriteConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createStubEmbedder } from '../../data/embed/embedder.js';

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

const fakeEmbedder = createStubEmbedder({ dimension: 1024 });

const cfg = {
  conflict_max_pairs_hydrated: 24,
  conflict_min_confidence: 0.4,
  conflict_max_age_days: 30,
};

test('fetchContradictors: returns hydrated pair when contradicts edge exists', async () => {
  const db = await fresh();
  const a = await store.note(db, fakeEmbedder, 'knowledge', {
    content: 'primary bank is Chase as of 2026-05-02',
    derived_by: 'manual',
  });
  const b = await store.note(db, fakeEmbedder, 'knowledge', {
    content: 'switched primary bank to Mercury 2026-04-12',
    derived_by: 'manual',
  });
  await store.flagContradiction(db, a.id, b.id);

  const out = await fetchContradictors(db, [a.id], cfg);
  assert.equal(out.pairs.length, 1);
  assert.equal(out.pairs_precap, 1);
  const p = out.pairs[0];
  // hit-side memo must be the one we passed in.
  assert.equal(String(p.hitSide.id), String(a.id));
  // other-side memo must be hydrated with content + confidence + ts + scope + freshness.
  assert.equal(String(p.otherSide.id), String(b.id));
  assert.equal(typeof p.otherSide.content, 'string');
  assert.equal(typeof p.otherSide.confidence, 'number');
  assert.equal(typeof p.otherSide.freshness, 'number');
  await close(db);
});

test('fetchContradictors: empty memoIds short-circuits without DB call', async () => {
  const db = await fresh();
  const out = await fetchContradictors(db, [], cfg);
  assert.equal(out.pairs.length, 0);
  assert.equal(out.pairs_precap, 0);
  await close(db);
});

test('fetchContradictors: no contradicts edge -> empty pairs', async () => {
  const db = await fresh();
  const a = await store.note(db, fakeEmbedder, 'knowledge', {
    content: 'a unique fact',
    derived_by: 'manual',
  });
  const out = await fetchContradictors(db, [a.id], cfg);
  assert.equal(out.pairs.length, 0);
  await close(db);
});

test('fetchContradictors: both endpoints in hits -> dedup yields one pair', async () => {
  const db = await fresh();
  const a = await store.note(db, fakeEmbedder, 'knowledge', {
    content: 'claim A',
    derived_by: 'manual',
  });
  const b = await store.note(db, fakeEmbedder, 'knowledge', {
    content: 'claim B',
    derived_by: 'manual',
  });
  await store.flagContradiction(db, a.id, b.id);
  const out = await fetchContradictors(db, [a.id, b.id], cfg);
  assert.equal(out.pairs.length, 1);
  assert.equal(out.pairs_precap, 1);
  await close(db);
});

test('fetchContradictors: returns {pairs:[], pairs_precap:0} on DB error', async () => {
  // Pass a fake db whose .query() throws — the function must swallow and return
  // the empty shape rather than propagate.
  const brokenDb = {
    query() {
      throw new Error('boom');
    },
  };
  const out = await fetchContradictors(brokenDb, ['memos:x'], cfg);
  assert.equal(out.pairs.length, 0);
  assert.equal(out.pairs_precap, 0);
});
