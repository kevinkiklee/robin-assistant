import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createStubEmbedder } from '../../src/embed/embedder.js';
import { createGetEntityTool } from '../../src/mcp/tools/get-entity.js';

import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin } from 'node:path';
import { writeConfig as __robinWriteConfig } from '../../src/runtime/config.js';

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
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  const e = createStubEmbedder({ dimension: 1024 });
  const v = Array.from(await e.embed('person: Alice'));
  const [created] = await db
    .query(surql`CREATE entities CONTENT ${{ name: 'Alice', type: 'person', embedding: v }}`)
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
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  const tool = createGetEntityTool({ db });
  await assert.rejects(tool.handler({ id: 'entities:nonexistent' }), /not found/i);
  await close(db);
});
