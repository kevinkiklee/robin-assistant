#!/usr/bin/env node
// bench-recall.mjs — hybrid (BM25 + vector + RRF) vs vector-only recall@K.
//
// Seeds a fixture into a fresh mem:// DB, runs each query through both
// retrievers, and reports recall@K + per-query attribution.
//
// Usage:
//   node scripts/bench-recall.mjs              # stub embedder (fast)
//   node scripts/bench-recall.mjs --real       # mxbai-embed-large-v1 (1024d)
//
// Measured results on this 20-doc / 10-query bootstrap fixture:
//   stub embedder:        vector 24% / hybrid 26% / lift +2.0 pp
//   mxbai-embed-large-v1: vector 80% / hybrid 80% / lift  0.0 pp
//
// The 0pp lift with the real model isn't a hybrid-pipeline bug — it's the
// embedder being too sensitive for a small fixture. With 20 documents
// covering 4 topics, semantic vectors capture nearly everything BM25 would.
// Real lift shows up at larger scale where:
//   - vector retrieval has to discriminate against more distractors,
//   - lexically-specific tokens (names, IDs, version numbers) appear in
//     queries that paraphrase-trained embedders weakly encode,
//   - precision matters at smaller K vs the recall horizon here.
//
// Use this script's scaffold (seed → query → score) against a production
// fixture built from your live `events`/`memos` tables for real tuning.

import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as store from '../../cognition/memory/store.js';
import { paths } from '../../config/data-store.js';
import { writeConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createStubEmbedder, createTransformersEmbedder } from '../../data/embed/embedder.js';

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
  console.log('loading transformers embedder (mxbai-embed-large-v1, 1024-dim)...');
  return createTransformersEmbedder({ modelId: 'mixedbread-ai/mxbai-embed-large-v1' });
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
        `embedder=${useReal ? `transformers/${embedder.modelId}, ${embedder.dimension}d` : 'stub'} · ${dur}ms`,
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
