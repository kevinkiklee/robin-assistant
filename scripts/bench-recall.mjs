#!/usr/bin/env node
// bench-recall.mjs — hybrid (BM25 + vector + RRF) vs vector-only recall@K.
//
// Seeds a fixture into a fresh mem:// DB, runs each query through both
// retrievers, and reports recall@K + per-query attribution.
//
// Usage:
//   node scripts/bench-recall.mjs              # stub embedder (fast, ~0% lift)
//   node scripts/bench-recall.mjs --real       # transformers bge-small-en
//
// The stub embedder is a word-bag hash so its vectors overlap with BM25 on
// exact-token queries; the real lift signal needs a model that captures
// semantic similarity. Use --real for production tuning of RRF parameters
// (model download is ~30MB the first run).

import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { close, connect } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { createStubEmbedder, createTransformersEmbedder } from '../src/embed/embedder.js';
import * as store from '../src/memory/store.js';
import { writeConfig } from '../src/runtime/config.js';
import { paths } from '../src/runtime/data-store.js';

const useReal = process.argv.includes('--real');

// Fixture: 20 docs covering pizza / work-deploy / code-refactor / music topics.
// Queries deliberately exercise lexical-only, semantic-only, and mixed matches
// so a real (sentence-aware) embedder will diverge from BM25 in measurable ways.
const FIXTURES = [
  { id: 'd1', content: 'Ordered pepperoni pizza for dinner with Alice tonight', topic: 'pizza' },
  { id: 'd2', content: 'Pizzeria on 5th was packed; margherita was excellent', topic: 'pizza' },
  { id: 'd3', content: 'Carbs binge: pie, dough, mozzarella — call it what it is', topic: 'pizza' },
  { id: 'd4', content: 'Italian food cravings hit hard around 8pm', topic: 'pizza' },
  { id: 'd5', content: 'Deployed the auth service to prod after lunch', topic: 'work' },
  { id: 'd6', content: 'Pushed the OAuth refresh fix to staging environment', topic: 'work' },
  { id: 'd7', content: 'Released v2.3.1 — token endpoint hotfix', topic: 'work' },
  { id: 'd8', content: 'Standup ran long; bug in the JWT expiration logic', topic: 'work' },
  {
    id: 'd9',
    content: 'Refactored the recall pipeline to use RRF fusion across BM25 and vector',
    topic: 'code',
  },
  { id: 'd10', content: 'Wrote unit tests for the edges TYPE RELATION rename', topic: 'code' },
  { id: 'd11', content: 'Reviewed the migration PR — added a checksum gate', topic: 'code' },
  { id: 'd12', content: 'Cleaned up the dream pipeline step modules', topic: 'code' },
  { id: 'd13', content: 'Listened to the new Tame Impala album on the way home', topic: 'music' },
  { id: 'd14', content: 'Spotify wrapped landed; lots of post-rock this year', topic: 'music' },
  { id: 'd15', content: 'Concert tickets for Mogwai went on sale, grabbed two', topic: 'music' },
  { id: 'd16', content: 'Vinyl record collection grew with a Slowdive reissue', topic: 'music' },
  // Lexically tricky distractors — same words, different topics:
  { id: 'd17', content: 'Pizza-shaped UI bug in the dashboard rendering', topic: 'code' },
  { id: 'd18', content: 'Stagger releases by environment — token bucket pattern', topic: 'work' },
  {
    id: 'd19',
    content: 'Read about token economy in the Spotify rec system paper',
    topic: 'music',
  },
  {
    id: 'd20',
    content: 'OAuth flow diagram on the whiteboard during architecture review',
    topic: 'work',
  },
];

const QUERIES = [
  // Lexical-heavy: exact tokens present in the target topic.
  { q: 'pizza pepperoni', topic: 'pizza' },
  { q: 'OAuth refresh staging', topic: 'work' },
  { q: 'Mogwai Slowdive vinyl', topic: 'music' },
  { q: 'TYPE RELATION rename', topic: 'code' },
  // Semantic-only: paraphrase without the topic's signature words.
  { q: 'craving Italian food at night', topic: 'pizza' },
  { q: 'shipping a backend hotfix to production', topic: 'work' },
  { q: 'discovering a new band recently', topic: 'music' },
  { q: 'cleaning up server-side code', topic: 'code' },
  // Mixed: one strong token + one paraphrase term.
  { q: 'pizza cravings dinner', topic: 'pizza' },
  { q: 'token bucket release strategy', topic: 'work' },
];

const K = 5;

async function makeEmbedder() {
  if (!useReal) return createStubEmbedder({ dimension: 1024 });
  console.log('loading transformers embedder (bge-small-en-v1.5)...');
  return createTransformersEmbedder({ modelId: 'Xenova/bge-small-en-v1.5' });
}

async function seed(db, embedder) {
  for (const f of FIXTURES) {
    await store.remember(db, embedder, {
      source: 'manual',
      content: f.content,
      tags: [f.topic],
    });
  }
}

async function recallAt(db, embedder, query, opts) {
  const { hits } = await store.searchEvents(db, embedder, query, { limit: K, ...opts });
  return hits.map((h) => ({
    content: h.record.content,
    tags: h.record.tags,
    sources: h._sources ?? [],
  }));
}

function hitsTopic(hits, topic) {
  return hits.filter((h) => Array.isArray(h.tags) && h.tags.includes(topic)).length;
}

function bm25Only(hits) {
  return hits.filter((h) => h.sources?.includes('bm25') && !h.sources?.includes('knn')).length;
}
function knnOnly(hits) {
  return hits.filter((h) => h.sources?.includes('knn') && !h.sources?.includes('bm25')).length;
}
function bothLanes(hits) {
  return hits.filter((h) => h.sources?.includes('knn') && h.sources?.includes('bm25')).length;
}

async function bench() {
  const home = join(tmpdir(), `robin-bench-recall-${process.pid}`);
  mkdirSync(home, { recursive: true });
  process.env.ROBIN_HOME = home;
  await writeConfig({ embedder_profile: 'mxbai-1024' });

  const db = await connect({ engine: 'mem://' });
  const embedder = await makeEmbedder();
  // Embed once to warm up; bge-small-en-v1.5 is slow on the first call.
  if (useReal) await embedder.embed('warmup');

  try {
    await runMigrations(db, paths.source.migrations());
    await seed(db, embedder);

    const tStart = Date.now();
    let vectorTotal = 0;
    let hybridTotal = 0;
    let possibleTotal = 0;
    const rows = [];
    for (const q of QUERIES) {
      const possible = FIXTURES.filter((f) => f.topic === q.topic).length;
      possibleTotal += possible;
      const vec = await recallAt(db, embedder, q.q, { disableBm25: true });
      const hyb = await recallAt(db, embedder, q.q);
      const vMatch = hitsTopic(vec, q.topic);
      const hMatch = hitsTopic(hyb, q.topic);
      vectorTotal += vMatch;
      hybridTotal += hMatch;
      rows.push({
        query: q.q,
        topic: q.topic,
        possible,
        vector: vMatch,
        hybrid: hMatch,
        bm25_only: bm25Only(hyb),
        knn_only: knnOnly(hyb),
        both: bothLanes(hyb),
      });
    }
    const dur = Date.now() - tStart;

    const vectorRecall = vectorTotal / possibleTotal;
    const hybridRecall = hybridTotal / possibleTotal;
    const lift = hybridRecall - vectorRecall;

    console.log(
      `\nbench-recall — ${FIXTURES.length} docs · ${QUERIES.length} queries · K=${K} · ` +
        `embedder=${useReal ? 'transformers/bge-small-en' : 'stub'} · ${dur}ms`,
    );
    console.log('');
    console.log('per-query (possible/vector/hybrid · bm25-only/knn-only/both):');
    for (const r of rows) {
      console.log(
        `  [${r.topic.padEnd(5)}] ${r.possible}/${r.vector}/${r.hybrid} · ` +
          `${r.bm25_only}/${r.knn_only}/${r.both} · "${r.query}"`,
      );
    }
    console.log('');
    console.log(`vector recall@${K}: ${(vectorRecall * 100).toFixed(1)}%`);
    console.log(`hybrid recall@${K}: ${(hybridRecall * 100).toFixed(1)}%`);
    console.log(`lift (hybrid − vector): ${(lift * 100).toFixed(1)} pp`);
    if (lift < -0.05) {
      console.error('\nFAIL — hybrid recall regressed > 5pp vs vector-only.');
      process.exit(1);
    }
  } finally {
    await close(db);
  }
}

bench().catch((e) => {
  console.error('bench-recall crashed:', e);
  process.exit(2);
});
