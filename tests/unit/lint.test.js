import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createStubEmbedder } from '../../src/embed/embedder.js';
import { createLintTool } from '../../src/mcp/tools/lint.js';

import { writeConfig as __wc } from '../../src/runtime/config.js';

const __h = join(tmpdir(), `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
mkdirSync(__h, { recursive: true });
process.env.ROBIN_HOME = __h;
await __wc({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return { db, embedder: createStubEmbedder({ dimension: 1024 }) };
}

test('lint — empty DB → no issues', async () => {
  const { db } = await fresh();
  const t = createLintTool({ db });
  const r = await t.handler({});
  assert.equal(r.ok, true);
  assert.equal(r.total, 0);
  assert.equal(r.returned, 0);
  assert.equal(r.issues.length, 0);
  await close(db);
});

test('lint — orphan entity is reported', async () => {
  const { db, embedder } = await fresh();
  const emb = Array.from(await embedder.embed('orph'));
  await db
    .query(surql`CREATE entities CONTENT ${{ name: 'Orph', type: 'thing'}}`)
    .collect();
  const t = createLintTool({ db });
  const r = await t.handler({});
  assert.equal(r.total, 1);
  assert.equal(r.issues[0].kind, 'orphan_entity');
  await close(db);
});

test('lint — limit caps issues', async () => {
  const { db, embedder } = await fresh();
  for (let i = 0; i < 5; i++) {
    const emb = Array.from(await embedder.embed(`x${i}`));
    await db
      .query(surql`CREATE entities CONTENT ${{ name: `X${i}`, type: 'thing'}}`)
      .collect();
  }
  const t = createLintTool({ db });
  const r = await t.handler({ limit: 2 });
  assert.equal(r.total, 5);
  assert.equal(r.returned, 2);
  await close(db);
});
