#!/usr/bin/env node
// Manual smoke: open Robin's DB (via $ROBIN_HOME or .robin-home pointer), run a recall query, print results.
// Not a public CLI. Phase 3 will build the real agent interface.

import { close, connect, defaultDbUrl } from '../../data/db/client.js';
import { createTransformersEmbedder } from '../../data/embed/embedder.js';
import { recall } from '../../cognition/intuition/engine.js';
import { ensureHome } from '../../config/data-store.js';

const query = process.argv.slice(2).join(' ');
if (!query) {
  console.error('usage: node scripts/dev-recall.js "<query>"');
  process.exit(1);
}

await ensureHome();
const db = await connect({ engine: await defaultDbUrl() });
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
