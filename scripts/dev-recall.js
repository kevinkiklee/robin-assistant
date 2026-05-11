#!/usr/bin/env node
// Manual smoke: open ~/.robin's DB, run a recall query, print results.
// Not a public CLI. Phase 3 will build the real agent interface.

import { close, connect } from '../src/db/client.js';
import { createTransformersEmbedder } from '../src/embed/embedder.js';
import { recall } from '../src/recall/index.js';
import { ensureHome, paths } from '../src/runtime/data-store.js';

const query = process.argv.slice(2).join(' ');
if (!query) {
  console.error('usage: node scripts/dev-recall.js "<query>"');
  process.exit(1);
}

await ensureHome();
const db = await connect({ engine: `rocksdb://${paths.data.db()}` });
try {
  const embedder = await createTransformersEmbedder();
  const r = await recall(db, embedder, query, { limit: 10 });
  for (const h of r.hits) {
    const ts = new Date(h.ts).toISOString();
    console.log(`[${ts}] [${h.source}] dist=${h.dist.toFixed(3)} :: ${h.content}`);
  }
  if (r.hits.length === 0) console.log('(no hits)');
} finally {
  await close(db);
}
process.exit(0); // workaround for @surrealdb/node v3.0.3 close-hang
