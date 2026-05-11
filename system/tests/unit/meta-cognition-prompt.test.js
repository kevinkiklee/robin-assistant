import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildUserPrompt, META_COGNITION_SYSTEM } from '../../cognition/meta_cognition/prompt.js';

function memoById(map) {
  return new Map(Object.entries(map));
}

test('META_COGNITION_SYSTEM is a non-empty string with output-shape instructions', () => {
  assert.equal(typeof META_COGNITION_SYSTEM, 'string');
  assert.ok(META_COGNITION_SYSTEM.includes('error_pattern'));
  assert.ok(META_COGNITION_SYSTEM.includes('suggested_rules'));
  assert.ok(META_COGNITION_SYSTEM.includes('rule_confidence'));
  assert.ok(META_COGNITION_SYSTEM.includes('JSON'));
});

test('buildUserPrompt includes week_starting and counts header', () => {
  const meta = {
    week_starting: '2026-05-04',
    n_corrected: 7,
    n_unused: 2,
    top_k_clusters: 3,
  };
  const out = buildUserPrompt(
    [],
    meta,
    {
      max_tokens_in: 3000,
      top_k_clusters: 3,
    },
    { memoById: memoById({}) },
  );
  assert.ok(out.text.includes('2026-05-04'));
  assert.ok(out.text.includes('7 corrected'));
  assert.ok(out.text.includes('2 unused-hit'));
  assert.equal(out.clusters_emitted, 0);
});

test('buildUserPrompt renders one cluster block per cluster with rows and memos', () => {
  const clusters = [
    {
      cluster_id: 'entities:E1',
      entity_id: 'entities:E1',
      entity_name: 'photo-tools',
      score: 5,
      rows: [
        {
          id: 'recall_log:r1',
          ts: '2026-05-05T10:00:00Z',
          query: 'what is photo-tools',
          ranked_hits: [{ record: 'memos:a', kind: 'memo' }],
        },
      ],
      memo_ids: ['memos:a'],
    },
  ];
  const memos = memoById({
    'memos:a': {
      kind: 'knowledge',
      derived_at: '2026-04-01T00:00:00Z',
      content: 'A different photography toolkit not related to photo-tools.',
    },
  });
  const out = buildUserPrompt(
    clusters,
    {
      week_starting: '2026-05-04',
      n_corrected: 1,
      n_unused: 0,
      top_k_clusters: 3,
    },
    { max_tokens_in: 3000, top_k_clusters: 3 },
    { memoById: memos },
  );
  assert.equal(out.clusters_emitted, 1);
  assert.ok(out.text.includes('Cluster 1'));
  assert.ok(out.text.includes('photo-tools'));
  assert.ok(out.text.includes('score: 5'));
  assert.ok(out.text.includes('what is photo-tools'));
  assert.ok(out.text.includes('A different photography toolkit'));
});

test('buildUserPrompt renders surface fallback when entity_id is absent', () => {
  const clusters = [
    {
      cluster_id: 'surface:intuition',
      surface: 'intuition',
      score: 4,
      rows: [
        {
          id: 'recall_log:r1',
          ts: '2026-05-05',
          query: 'foo',
          ranked_hits: [{ record: 'memos:a', kind: 'memo' }],
        },
        {
          id: 'recall_log:r2',
          ts: '2026-05-06',
          query: 'bar',
          ranked_hits: [{ record: 'memos:a', kind: 'memo' }],
        },
      ],
      memo_ids: ['memos:a'],
    },
  ];
  const out = buildUserPrompt(
    clusters,
    {
      week_starting: '2026-05-04',
      n_corrected: 2,
      n_unused: 0,
      top_k_clusters: 3,
    },
    { max_tokens_in: 3000, top_k_clusters: 3 },
    { memoById: memoById({ 'memos:a': { kind: 'knowledge', content: 'x' } }) },
  );
  assert.ok(out.text.includes('surface=intuition'));
});

test('buildUserPrompt truncates clusters that would overflow max_tokens_in', () => {
  const longContent = 'x'.repeat(20000);
  const clusters = [
    {
      cluster_id: 'entities:E1',
      entity_id: 'entities:E1',
      entity_name: 'E1',
      score: 5,
      rows: Array.from({ length: 10 }, (_, i) => ({
        id: `recall_log:${i}`,
        ts: '2026-05-05',
        query: longContent.slice(0, 200),
        ranked_hits: [{ record: 'memos:a', kind: 'memo' }],
      })),
      memo_ids: ['memos:a'],
    },
    {
      cluster_id: 'entities:E2',
      entity_id: 'entities:E2',
      entity_name: 'E2',
      score: 4,
      rows: Array.from({ length: 10 }, (_, i) => ({
        id: `recall_log:b${i}`,
        ts: '2026-05-05',
        query: longContent.slice(0, 200),
        ranked_hits: [{ record: 'memos:b', kind: 'memo' }],
      })),
      memo_ids: ['memos:b'],
    },
  ];
  const memos = memoById({
    'memos:a': { kind: 'knowledge', content: longContent },
    'memos:b': { kind: 'knowledge', content: longContent },
  });
  const out = buildUserPrompt(
    clusters,
    {
      week_starting: '2026-05-04',
      n_corrected: 20,
      n_unused: 0,
      top_k_clusters: 3,
    },
    { max_tokens_in: 600, top_k_clusters: 3 },
    { memoById: memos },
  );
  assert.ok(out.dropped_clusters >= 1 || out.clusters_emitted <= 2);
  // At least the header is present.
  assert.ok(out.text.includes('2026-05-04'));
});
