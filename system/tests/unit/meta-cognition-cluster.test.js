import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clusterByAboutEndpoints } from '../../cognition/meta_cognition/cluster.js';

const CFG = {
  top_k_clusters: 3,
  min_cluster_size: 2,
  unused_signal_weight: 0.33,
};

/**
 * @returns hydrated input shape:
 *   {
 *     rows: [{ id, outcome, source, ranked_hits: [{ record: 'memos:x', kind: 'memo' }] }],
 *     aboutByMemoId: Map<string, string[]>,
 *     entityNameById: Map<string, string>,
 *   }
 */
function H(rows, about, names = {}) {
  return {
    rows,
    aboutByMemoId: new Map(Object.entries(about).map(([k, v]) => [k, v])),
    entityNameById: new Map(Object.entries(names)),
  };
}

test('empty input → no clusters', () => {
  const r = clusterByAboutEndpoints(H([], {}), CFG);
  assert.deepEqual(r, []);
});

test('no about edges → no clusters (caller handles surface fallback)', () => {
  const rows = [
    {
      id: 'recall_log:1',
      outcome: 'corrected',
      ranked_hits: [{ record: 'memos:a', kind: 'memo' }],
    },
    {
      id: 'recall_log:2',
      outcome: 'corrected',
      ranked_hits: [{ record: 'memos:b', kind: 'memo' }],
    },
  ];
  const r = clusterByAboutEndpoints(H(rows, {}), CFG);
  assert.deepEqual(r, []);
});

test('single dominant entity returns one cluster with summed score', () => {
  const rows = Array.from({ length: 5 }, (_, i) => ({
    id: `recall_log:${i + 1}`,
    outcome: 'corrected',
    ranked_hits: [{ record: 'memos:a', kind: 'memo' }],
  }));
  const about = { 'memos:a': ['entities:E1'] };
  const r = clusterByAboutEndpoints(H(rows, about, { 'entities:E1': 'photo-tools' }), CFG);
  assert.equal(r.length, 1);
  assert.equal(r[0].entity_id, 'entities:E1');
  assert.equal(r[0].entity_name, 'photo-tools');
  assert.ok(Math.abs(r[0].score - 5.0) < 1e-9);
  assert.equal(r[0].rows.length, 5);
});

test('top_k_clusters caps result at 3', () => {
  // 6 entities each touched by 3 corrected rows.
  const rows = [];
  const about = {};
  for (let e = 1; e <= 6; e++) {
    const memoId = `memos:m${e}`;
    about[memoId] = [`entities:E${e}`];
    for (let i = 0; i < 3; i++) {
      rows.push({
        id: `recall_log:${e}-${i}`,
        outcome: 'corrected',
        ranked_hits: [{ record: memoId, kind: 'memo' }],
      });
    }
  }
  const r = clusterByAboutEndpoints(H(rows, about), CFG);
  assert.equal(r.length, 3);
});

test('min_cluster_size filters out singletons', () => {
  const rows = [
    {
      id: 'recall_log:1',
      outcome: 'corrected',
      ranked_hits: [{ record: 'memos:a', kind: 'memo' }],
    },
    {
      id: 'recall_log:2',
      outcome: 'corrected',
      ranked_hits: [{ record: 'memos:b', kind: 'memo' }],
    },
    {
      id: 'recall_log:3',
      outcome: 'corrected',
      ranked_hits: [{ record: 'memos:a', kind: 'memo' }],
    },
  ];
  const about = { 'memos:a': ['entities:E1'], 'memos:b': ['entities:E2'] };
  const r = clusterByAboutEndpoints(H(rows, about), CFG);
  assert.equal(r.length, 1, 'only E1 has ≥2 rows');
  assert.equal(r[0].entity_id, 'entities:E1');
});

test('unused-signal weight downweights secondary rows', () => {
  // 4 corrected rows touching E_A; 6 unused-hit rows touching E_B.
  // weights: A = 4 × 1.0 = 4.0; B = 6 × 0.33 = 1.98.
  const rows = [
    ...Array.from({ length: 4 }, (_, i) => ({
      id: `recall_log:a${i}`,
      outcome: 'corrected',
      ranked_hits: [{ record: 'memos:a', kind: 'memo' }],
    })),
    ...Array.from({ length: 6 }, (_, i) => ({
      id: `recall_log:b${i}`,
      outcome: 'unused', // sentinel — secondary query rows carry outcome='unused'
      ranked_hits: [{ record: 'memos:b', kind: 'memo' }],
    })),
  ];
  const about = { 'memos:a': ['entities:E_A'], 'memos:b': ['entities:E_B'] };
  const r = clusterByAboutEndpoints(H(rows, about), CFG);
  assert.equal(r.length, 2);
  assert.equal(r[0].entity_id, 'entities:E_A', 'A ranks above B');
  assert.ok(Math.abs(r[0].score - 4.0) < 1e-9);
  assert.ok(Math.abs(r[1].score - 1.98) < 1e-9);
});

test('row touching multiple top entities lands in each cluster', () => {
  const rows = [
    {
      id: 'recall_log:1',
      outcome: 'corrected',
      ranked_hits: [{ record: 'memos:a', kind: 'memo' }],
    },
    {
      id: 'recall_log:2',
      outcome: 'corrected',
      ranked_hits: [{ record: 'memos:a', kind: 'memo' }],
    },
    {
      id: 'recall_log:3',
      outcome: 'corrected',
      ranked_hits: [{ record: 'memos:m', kind: 'memo' }],
    }, // m touches A AND B
    {
      id: 'recall_log:4',
      outcome: 'corrected',
      ranked_hits: [{ record: 'memos:b', kind: 'memo' }],
    },
    {
      id: 'recall_log:5',
      outcome: 'corrected',
      ranked_hits: [{ record: 'memos:b', kind: 'memo' }],
    },
  ];
  const about = {
    'memos:a': ['entities:E_A'],
    'memos:b': ['entities:E_B'],
    'memos:m': ['entities:E_A', 'entities:E_B'],
  };
  const r = clusterByAboutEndpoints(H(rows, about), CFG);
  const a = r.find((c) => c.entity_id === 'entities:E_A');
  const b = r.find((c) => c.entity_id === 'entities:E_B');
  assert.ok(a && b);
  assert.equal(a.rows.length, 3, 'A cluster: rows 1,2,3');
  assert.equal(b.rows.length, 3, 'B cluster: rows 3,4,5');
});

test('per-cluster row cap truncates to 10', () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({
    id: `recall_log:${i}`,
    outcome: 'corrected',
    ranked_hits: [{ record: 'memos:a', kind: 'memo' }],
  }));
  const about = { 'memos:a': ['entities:E1'] };
  const r = clusterByAboutEndpoints(H(rows, about), CFG);
  assert.equal(r[0].rows.length, 10);
});

test('non-memo hits are skipped (events have no about edges)', () => {
  const rows = [
    {
      id: 'recall_log:1',
      outcome: 'corrected',
      ranked_hits: [
        { record: 'events:e1', kind: 'event' },
        { record: 'memos:a', kind: 'memo' },
      ],
    },
    {
      id: 'recall_log:2',
      outcome: 'corrected',
      ranked_hits: [{ record: 'memos:a', kind: 'memo' }],
    },
  ];
  const about = { 'memos:a': ['entities:E1'] };
  const r = clusterByAboutEndpoints(H(rows, about), CFG);
  assert.equal(r.length, 1);
  assert.equal(r[0].entity_id, 'entities:E1');
  assert.ok(Math.abs(r[0].score - 2.0) < 1e-9);
});
