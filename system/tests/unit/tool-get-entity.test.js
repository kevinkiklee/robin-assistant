import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { writeConfig as __robinWriteConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createStubEmbedder } from '../../data/embed/embedder.js';
import { createGetEntityTool } from '../../io/mcp/tools/get-entity.js';

// __robin_test_home_setup__
const __robinTestHome = __robinJoin(
  __robinTmpdir(),
  `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
);
__robinMkdirSync(__robinTestHome, { recursive: true });
process.env.ROBIN_HOME = __robinTestHome;
await __robinWriteConfig({ embedder_profile: 'mxbai-1024' });

test('get_entity returns the entity record', async () => {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  const e = createStubEmbedder({ dimension: 1024 });
  const _v = Array.from(await e.embed('person: Alice'));
  const [created] = await db
    .query(surql`CREATE entities CONTENT ${{ name: 'Alice', type: 'person' }}`)
    .collect();
  const id = (Array.isArray(created) ? created[0] : created).id;
  const tool = createGetEntityTool({ db });
  const r = await tool.handler({ id: String(id) });
  assert.equal(r.entity.name, 'Alice');
  assert.equal(r.entity.type, 'person');
  assert.ok(r.entity.edge_summary);
  await close(db);
});

test('get_entity throws on unknown id', async () => {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  const tool = createGetEntityTool({ db });
  await assert.rejects(tool.handler({ id: 'entities:nonexistent' }), /not found/i);
  await close(db);
});

test('get_entity rejects ids that would inject SurrealQL', async () => {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  const tool = createGetEntityTool({ db });
  const hostile = ['x; DELETE entities;', "abc' OR true", 'entities:abc OR 1=1', 'entities:`hack`'];
  for (const id of hostile) {
    await assert.rejects(tool.handler({ id }), /invalid record id/i);
  }
  await close(db);
});

test('get_entity rejects path_kinds outside the allow-list', async () => {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  const [c] = await db
    .query(surql`CREATE entities CONTENT ${{ name: 'A', type: 'person' }}`)
    .collect();
  const id = String((Array.isArray(c) ? c[0] : c).id);
  const tool = createGetEntityTool({ db });
  await assert.rejects(
    tool.handler({ id, path_to: id, path_kinds: ["'); DROP TABLE edges; --"] }),
    /not allowed/i,
  );
  await close(db);
});

test('get_entity path_to returns the shortest path through chained occurs_with', async () => {
  const { writeCoOccursWith } = await import('../../cognition/biographer/edges.js');
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  const e = createStubEmbedder({ dimension: 1024 });
  const ids = [];
  for (const n of ['A', 'B', 'C']) {
    const _v = Array.from(await e.embed(`person: ${n}`));
    const [c] = await db
      .query(surql`CREATE entities CONTENT ${{ name: n, type: 'person' }}`)
      .collect();
    ids.push((Array.isArray(c) ? c[0] : c).id);
  }
  // Chain: A — B — C
  await writeCoOccursWith(db, [ids[0], ids[1]]);
  await writeCoOccursWith(db, [ids[1], ids[2]]);

  const tool = createGetEntityTool({ db });
  const r = await tool.handler({
    id: String(ids[0]),
    path_to: String(ids[2]),
    path_kinds: ['occurs_with'],
    path_max_depth: 4,
  });
  assert.ok(r.path?.found, 'expected a path');
  assert.equal(r.path.distance, 2);
  assert.equal(r.path.path[0], String(ids[0]));
  assert.equal(r.path.path[r.path.path.length - 1], String(ids[2]));
  await close(db);
});

test('get_entity path_to returns null when no path exists', async () => {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  const e = createStubEmbedder({ dimension: 1024 });
  const _v = Array.from(await e.embed('person: lonely'));
  const [c1] = await db
    .query(surql`CREATE entities CONTENT ${{ name: 'A', type: 'person' }}`)
    .collect();
  const [c2] = await db
    .query(surql`CREATE entities CONTENT ${{ name: 'B', type: 'person' }}`)
    .collect();
  const a = (Array.isArray(c1) ? c1[0] : c1).id;
  const b = (Array.isArray(c2) ? c2[0] : c2).id;
  const tool = createGetEntityTool({ db });
  const r = await tool.handler({ id: String(a), path_to: String(b), path_kinds: ['occurs_with'] });
  assert.equal(r.path?.found, false);
  assert.equal(r.path?.path, null);
  await close(db);
});
