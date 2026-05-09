import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createStubEmbedder } from '../../src/embed/embedder.js';
import { createRememberTool } from '../../src/mcp/tools/remember.js';

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return db;
}

test('remember tool writes an event', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 384 });
  const queue = { enqueue: () => Promise.resolve() };
  const tool = createRememberTool({ db, embedder: e, queue });
  const result = await tool.handler({ content: 'noted', source: 'manual' });
  assert.ok(result.id);
  const [rows] = await db.query(surql`SELECT count() AS n FROM events GROUP ALL`).collect();
  assert.equal(rows[0].n, 1);
  await close(db);
});

test('remember triggers biographer when trigger_biographer not false', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 384 });
  const enqueueCalls = [];
  const queue = {
    enqueue: (id) => {
      enqueueCalls.push(id);
      return Promise.resolve();
    },
  };
  const tool = createRememberTool({ db, embedder: e, queue });
  await tool.handler({ content: 'x' });
  // Wait briefly for fire-and-forget enqueue to complete
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(enqueueCalls.length, 1);
  await close(db);
});

test('remember skips biographer when trigger_biographer: false', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 384 });
  const enqueueCalls = [];
  const queue = {
    enqueue: (id) => {
      enqueueCalls.push(id);
      return Promise.resolve();
    },
  };
  const tool = createRememberTool({ db, embedder: e, queue });
  await tool.handler({ content: 'x', trigger_biographer: false });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(enqueueCalls.length, 0);
  await close(db);
});
