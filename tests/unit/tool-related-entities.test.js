import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createStubEmbedder } from '../../src/embed/embedder.js';
import { writeCoOccursWith } from '../../src/graph/edges.js';
import { createRelatedEntitiesTool } from '../../src/mcp/tools/related-entities.js';

test('related_entities returns co_occurs_with neighbors', async () => {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  const e = createStubEmbedder({ dimension: 384 });
  const ids = [];
  for (const n of ['Alice', 'Bob', 'Charlie']) {
    const v = Array.from(await e.embed(`person: ${n}`));
    const [c] = await db
      .query(surql`CREATE entities CONTENT ${{ name: n, type: 'person', embedding: v }}`)
      .collect();
    ids.push((Array.isArray(c) ? c[0] : c).id);
  }
  await writeCoOccursWith(db, ids);
  const tool = createRelatedEntitiesTool({ db });
  const r = await tool.handler({ id: String(ids[0]), depth: 1, limit: 10 });
  assert.ok(r.related.length >= 2);
  await close(db);
});

test('related_entities returns empty for entity with no edges', async () => {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  const e = createStubEmbedder({ dimension: 384 });
  const v = Array.from(await e.embed('person: Solo'));
  const [c] = await db
    .query(surql`CREATE entities CONTENT ${{ name: 'Solo', type: 'person', embedding: v }}`)
    .collect();
  const id = (Array.isArray(c) ? c[0] : c).id;
  const tool = createRelatedEntitiesTool({ db });
  const r = await tool.handler({ id: String(id) });
  assert.deepEqual(r.related, []);
  await close(db);
});
