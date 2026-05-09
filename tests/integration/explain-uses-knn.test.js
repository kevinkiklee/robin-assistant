import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { recordEvent } from '../../src/capture/record-event.js';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createStubEmbedder } from '../../src/embed/embedder.js';
import { recall } from '../../src/recall/index.js';

test('recall query plan uses the HNSW index (Iterator: Knn)', async () => {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  const e = createStubEmbedder({ dimension: 384 });
  // Need at least one row for the planner to pick the vector index path
  await recordEvent(db, e, { source: 'cli', content: 'one' });
  const r = await recall(db, e, 'one', { explain: true });
  assert.match(
    r.explain,
    /Knn|knn/,
    `expected EXPLAIN to mention Knn iterator; got:\n${r.explain}`,
  );
  await close(db);
});
