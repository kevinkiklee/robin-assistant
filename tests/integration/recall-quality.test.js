import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { recordEvent } from '../../src/capture/record-event.js';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createTransformersEmbedder } from '../../src/embed/embedder.js';
import { recall } from '../../src/recall/index.js';

const FIXTURES = resolve(import.meta.dirname, '../fixtures');

function ndcgAtK(ranked, isRelevant, k) {
  const dcg = ranked.slice(0, k).reduce((s, hit, i) => {
    const rel = isRelevant(hit) ? 1 : 0;
    return s + rel / Math.log2(i + 2);
  }, 0);
  const idcg = Array.from({ length: k }, (_, i) => 1 / Math.log2(i + 2)).reduce((a, b) => a + b, 0);
  return idcg === 0 ? 0 : dcg / idcg;
}

test('recall achieves NDCG@5 ≥ 0.75 against synthetic clusters', { timeout: 180_000 }, async () => {
  const events = JSON.parse(await readFile(resolve(FIXTURES, 'synthetic-events.json'), 'utf8'));
  const pairs = JSON.parse(await readFile(resolve(FIXTURES, 'seed-recall-pairs.json'), 'utf8'));

  const embedder = await createTransformersEmbedder({ modelId: 'Xenova/bge-small-en-v1.5' });
  assert.equal(embedder.dimension, 384);

  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));

  const clusterByContent = new Map(events.map((e) => [e.content, e.cluster]));

  for (const e of events) {
    await recordEvent(db, embedder, { source: 'cli', content: e.content });
  }

  const scores = [];
  for (const p of pairs) {
    const r = await recall(db, embedder, p.query, { limit: 10 });
    const ndcg = ndcgAtK(r.hits, (h) => clusterByContent.get(h.content) === p.cluster, 5);
    scores.push(ndcg);
  }
  const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
  assert.ok(
    avg >= 0.75,
    `expected NDCG@5 ≥ 0.75, got ${avg.toFixed(3)} (per-query: ${scores.map((s) => s.toFixed(2)).join(', ')})`,
  );
  await close(db);
});
