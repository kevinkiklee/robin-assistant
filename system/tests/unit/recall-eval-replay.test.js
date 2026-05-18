import assert from 'node:assert/strict';
import { test } from 'node:test';
import { replayRow } from '../../cognition/intuition/eval.js';

function stubEmbedder() {
  return {
    async embed(text) {
      const v = new Float32Array(4);
      let h = 0;
      for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
      v[0] = (h & 0xff) / 256;
      v[1] = ((h >> 8) & 0xff) / 256;
      v[2] = ((h >> 16) & 0xff) / 256;
      v[3] = ((h >> 24) & 0xff) / 256;
      return v;
    },
  };
}

function fixedEmbedder(vector) {
  return {
    async embed() {
      return new Float32Array(vector);
    },
  };
}

test('replayRow re-scores hits using current embeddings + rank.score', async () => {
  const row = {
    id: 'recall_log:r1',
    query: 'sourdough',
    ranked_hits: [
      { record: 'memos:m1', kind: 'memo', rank: 0 },
      { record: 'memos:m2', kind: 'memo', rank: 1 },
    ],
    meta: { from: 'intuition' },
  };
  const hydratedRecords = new Map([
    [
      'memos:m1',
      { id: 'memos:m1', content: 'sourdough recipe', kind: 'knowledge', confidence: 0.8 },
    ],
    [
      'memos:m2',
      { id: 'memos:m2', content: 'kettlebell program', kind: 'knowledge', confidence: 0.7 },
    ],
  ]);
  // Deterministic vectors so we can assert on ordering and tau band:
  //   query vec = m1 vec (perfect match) → distance(m1)=0
  //   m2 vec orthogonal → distance(m2)=1
  // → m1 outranks m2 → original order preserved → tau == 1
  const currentVectors = new Map([
    ['memos:m1', new Float32Array([1, 0, 0, 0])],
    ['memos:m2', new Float32Array([0, 1, 0, 0])],
  ]);
  const out = await replayRow({
    row,
    embedder: fixedEmbedder([1, 0, 0, 0]),
    hydratedRecords,
    currentVectors,
    config: { mmr_threshold: 0.92, mmr_use_cosine: true, entity_boost_enabled: false },
  });
  assert.equal(out.skipped, false);
  assert.equal(out.replayed_hits.length, 2);
  assert.equal(out.replayed_hits[0].id, 'memos:m1'); // higher score
  assert.ok(out.replayed_hits[0].score > out.replayed_hits[1].score);
  assert.ok(Math.abs(out.kendall_tau - 1.0) < 1e-9); // identical ordering
});

test('replayRow A2 enabled vs disabled produces different scores on overlapping entity', async () => {
  const row = {
    id: 'recall_log:r3',
    query: 'karen',
    ranked_hits: [
      { record: 'memos:m1', kind: 'memo', rank: 0 },
      { record: 'memos:m2', kind: 'memo', rank: 1 },
    ],
    meta: { from: 'intuition' },
  };
  // Both memos must share an explicit `decay_anchor` — otherwise freshness()
  // falls back to `new Date(Date.now())` for each call, and under concurrent
  // test loads the ms drift between m1's and m2's anchors can flip the sort
  // order; MMR (identical vectors → cosine 1.0 > 0.92 threshold) then drops
  // m1 instead of m2, and `find(h => h.id === 'memos:m1')` returns undefined.
  const anchor = new Date('2026-01-01T00:00:00Z');
  const hydratedRecords = new Map([
    [
      'memos:m1',
      {
        id: 'memos:m1',
        content: 'karen prefers tomatoes',
        kind: 'knowledge',
        confidence: 0.8,
        decay_anchor: anchor,
      },
    ],
    [
      'memos:m2',
      {
        id: 'memos:m2',
        content: 'kettlebell program',
        kind: 'knowledge',
        confidence: 0.8,
        decay_anchor: anchor,
      },
    ],
  ]);
  const currentVectors = new Map([
    ['memos:m1', new Float32Array([1, 0, 0, 0])],
    ['memos:m2', new Float32Array([1, 0, 0, 0])],
  ]);
  const baseArgs = {
    row,
    embedder: fixedEmbedder([1, 0, 0, 0]),
    hydratedRecords,
    currentVectors,
  };
  const off = await replayRow({
    ...baseArgs,
    config: { mmr_use_cosine: true, entity_boost_enabled: false },
  });
  const on = await replayRow({
    ...baseArgs,
    config: {
      mmr_use_cosine: true,
      entity_boost_enabled: true,
      entity_boost_per_overlap: 0.1,
      entity_boost_max: 1.25,
    },
    matchedEntityIds: new Set(['entities:karen']),
    aboutByMemo: new Map([['memos:m1', new Set(['entities:karen'])]]),
  });
  const m1Off = off.replayed_hits.find((h) => h.id === 'memos:m1');
  const m1On = on.replayed_hits.find((h) => h.id === 'memos:m1');
  assert.ok(m1On.score > m1Off.score, 'A2-on score must exceed A2-off for boosted memo');
  assert.equal(m1On.components.entityBoost, 1.1);
  assert.equal(m1Off.components.entityBoost, 1.0);
});

test('replayRow returns skipped=true when any record is missing', async () => {
  const row = {
    id: 'recall_log:r2',
    query: 'x',
    ranked_hits: [{ record: 'memos:gone', kind: 'memo', rank: 0 }],
    meta: { from: 'intuition' },
  };
  const out = await replayRow({
    row,
    embedder: stubEmbedder(),
    hydratedRecords: new Map(),
    currentVectors: new Map(),
    config: {},
  });
  assert.equal(out.skipped, true);
});
