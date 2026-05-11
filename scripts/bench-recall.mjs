#!/usr/bin/env node
// bench-recall.mjs — hybrid (BM25 + vector + RRF) vs vector-only recall@K.
//
// Seeds a small fixture set into a fresh mem:// DB, runs each query through
// both retrievers, and reports recall@K. The fixture is intentionally tiny
// (~12 docs, ~6 queries) so it runs in a few seconds and isn't sensitive to
// embedding model quality — the goal is to detect a regression in the hybrid
// pipeline, not to claim absolute model performance.
//
// For meaningful production tuning, build a larger golden-fixture set from
// your live `events` and `memos` tables; this script's harness scaffold
// (seed → run → score → diff) carries over.

import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { close, connect } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import * as store from '../src/memory/store.js';
import { writeConfig } from '../src/runtime/config.js';
import { paths } from '../src/runtime/data-store.js';

// Tiny deterministic stub embedder: 16-dim vector from term-presence buckets.
// Not meant to model anything real — just gives the kNN lane something to
// pick up on so RRF can fuse with BM25.
function stubEmbedder(dim = 1024) {
  return {
    embed: async (text) => {
      const v = new Float32Array(dim);
      const tokens = String(text).toLowerCase().split(/\W+/).filter(Boolean);
      for (const t of tokens) {
        let h = 0;
        for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) | 0;
        v[((h % dim) + dim) % dim] += 1 / Math.sqrt(tokens.length || 1);
      }
      return v;
    },
  };
}

// Fixture: 12 events covering pizza/work/code/music topics, with deliberate
// lexical-vs-semantic mismatches.
const FIXTURES = [
  { id: 'e1', content: 'Ordered pepperoni pizza for dinner with Alice', topic: 'pizza' },
  { id: 'e2', content: 'Pizzeria on 5th was packed; tried the margherita', topic: 'pizza' },
  { id: 'e3', content: 'Carbs binge: pie, dough, mozzarella — call it what it is', topic: 'pizza' },
  { id: 'e4', content: 'Deployed the auth service to prod', topic: 'work' },
  { id: 'e5', content: 'Pushed the OAuth fix to staging', topic: 'work' },
  { id: 'e6', content: 'Standup ran long; blocker on the token refresh code', topic: 'work' },
  { id: 'e7', content: 'Refactored the recall pipeline to use RRF fusion', topic: 'code' },
  { id: 'e8', content: 'Wrote unit tests for the edges TYPE RELATION rename', topic: 'code' },
  { id: 'e9', content: 'Reviewed the migration PR — added a checksum gate', topic: 'code' },
  { id: 'e10', content: 'Listened to the new Tame Impala album on the way home', topic: 'music' },
  { id: 'e11', content: 'Spotify wrapped landed; lots of post-rock this year', topic: 'music' },
  { id: 'e12', content: 'Concert tickets for Mogwai went on sale, grabbed two', topic: 'music' },
];

const QUERIES = [
  { q: 'pizza', topic: 'pizza' }, // lexical match
  { q: 'Italian dinner with friends', topic: 'pizza' }, // semantic-only
  { q: 'authentication token', topic: 'work' }, // lexical-ish
  { q: 'released to production environment', topic: 'work' }, // semantic
  { q: 'edges schema rewrite', topic: 'code' }, // lexical
  { q: 'concert tickets', topic: 'music' }, // lexical
];

const K = 5;

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
  return hits.map((h) => ({ content: h.record.content, tags: h.record.tags }));
}

function hitsTopic(hits, topic) {
  return hits.filter((h) => Array.isArray(h.tags) && h.tags.includes(topic)).length;
}

async function bench() {
  const home = join(tmpdir(), `robin-bench-recall-${process.pid}`);
  mkdirSync(home, { recursive: true });
  process.env.ROBIN_HOME = home;
  await writeConfig({ embedder_profile: 'mxbai-1024' });

  const db = await connect({ engine: 'mem://' });
  const embedder = stubEmbedder(1024);
  try {
    await runMigrations(db, paths.source.migrations());
    await seed(db, embedder);

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
      rows.push({ query: q.q, topic: q.topic, possible, vector: vMatch, hybrid: hMatch });
    }

    const vectorRecall = vectorTotal / possibleTotal;
    const hybridRecall = hybridTotal / possibleTotal;
    const lift = hybridRecall - vectorRecall;

    console.log(
      `bench-recall — fixture: ${FIXTURES.length} docs, ${QUERIES.length} queries, K=${K}`,
    );
    console.log('');
    console.log('per-query:');
    for (const r of rows) {
      console.log(
        `  [${r.topic.padEnd(5)}] "${r.query}" — possible=${r.possible} vector=${r.vector} hybrid=${r.hybrid}`,
      );
    }
    console.log('');
    console.log(`vector recall@${K}: ${(vectorRecall * 100).toFixed(1)}%`);
    console.log(`hybrid recall@${K}: ${(hybridRecall * 100).toFixed(1)}%`);
    console.log(`lift (hybrid − vector): ${(lift * 100).toFixed(1)} pp`);
    // Non-zero exit only if hybrid actively regresses; the bootstrap fixture is
    // too small to enforce the +15% target — we just want a tripwire on
    // pipeline breakage.
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
