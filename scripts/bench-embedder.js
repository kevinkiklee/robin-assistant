#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { createTransformersEmbedder } from '../src/embed/embedder.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(here, '../tests/fixtures');

const MODELS = [
  'Xenova/bge-small-en-v1.5',
  'Xenova/bge-base-en-v1.5',
  'Xenova/bge-large-en-v1.5',
  'Xenova/all-MiniLM-L6-v2',
];

function cosineDist(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return 1 - dot;
}

function ndcgAtK(ranked, isRelevant, k) {
  const dcg = ranked
    .slice(0, k)
    .reduce((s, h, i) => s + (isRelevant(h) ? 1 : 0) / Math.log2(i + 2), 0);
  const idcg = Array.from({ length: k }, (_, i) => 1 / Math.log2(i + 2)).reduce((a, b) => a + b, 0);
  return idcg === 0 ? 0 : dcg / idcg;
}

function quantile(arr, q) {
  const sorted = [...arr].sort((a, b) => a - b);
  const i = Math.ceil(q * sorted.length) - 1;
  return sorted[Math.max(0, i)];
}

async function bench(modelId) {
  const events = JSON.parse(await readFile(resolve(FIXTURES, 'synthetic-events.json'), 'utf8'));
  const pairs = JSON.parse(await readFile(resolve(FIXTURES, 'seed-recall-pairs.json'), 'utf8'));

  console.log(`\n=== ${modelId} ===`);
  const t0 = performance.now();
  const embedder = await createTransformersEmbedder({ modelId });
  console.log(`load: ${(performance.now() - t0).toFixed(0)}ms, dim=${embedder.dimension}`);

  const eventVecs = [];
  for (const e of events) eventVecs.push({ ...e, vec: await embedder.embed(e.content) });

  const ndcgs5 = [];
  const ndcgs10 = [];
  const latencies = [];
  for (const p of pairs) {
    const t = performance.now();
    const qv = await embedder.embed(p.query);
    latencies.push(performance.now() - t);
    const ranked = eventVecs
      .map((e) => ({ ...e, dist: cosineDist(e.vec, qv) }))
      .sort((a, b) => a.dist - b.dist);
    ndcgs5.push(ndcgAtK(ranked, (h) => h.cluster === p.cluster, 5));
    ndcgs10.push(ndcgAtK(ranked, (h) => h.cluster === p.cluster, 10));
  }
  const avg = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  return {
    modelId,
    dim: embedder.dimension,
    ndcg5: avg(ndcgs5),
    ndcg10: avg(ndcgs10),
    p50: quantile(latencies, 0.5),
    p95: quantile(latencies, 0.95),
  };
}

const results = [];
for (const m of MODELS) {
  try {
    results.push(await bench(m));
  } catch (e) {
    console.error(`${m} failed: ${e.message}`);
  }
}

console.log('\n| Model | Dim | NDCG@5 | NDCG@10 | p50 (ms) | p95 (ms) |');
console.log('|---|---|---|---|---|---|');
for (const r of results) {
  console.log(
    `| ${r.modelId} | ${r.dim} | ${r.ndcg5.toFixed(3)} | ${r.ndcg10.toFixed(3)} | ${r.p50.toFixed(0)} | ${r.p95.toFixed(0)} |`,
  );
}
