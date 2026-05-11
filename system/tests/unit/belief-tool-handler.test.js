import assert from 'node:assert/strict';
import { mkdirSync as __mk } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { _resetBeliefConfigCacheForTests } from '../../cognition/belief/config.js';
import * as store from '../../cognition/memory/store.js';
import { writeConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createStubEmbedder } from '../../data/embed/embedder.js';
import { createBeliefTool } from '../../io/mcp/tools/belief.js';

const HOME = join(tmpdir(), `robin-bt-${process.pid}-${Math.random().toString(36).slice(2)}`);
__mk(HOME, { recursive: true });
process.env.ROBIN_HOME = HOME;
await writeConfig({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  _resetBeliefConfigCacheForTests();
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  return db;
}

test('belief tool: empty DB -> unknown / fallback_path=no_hits, in shadow', async () => {
  const db = await fresh();
  // Migration 0021 (cognition-wave-enable) flipped shadow_mode to false; this
  // test asserts in-shadow behavior, so set the precondition explicitly.
  await db.query('UPSERT runtime:`belief.config` SET value.shadow_mode = true').collect();
  _resetBeliefConfigCacheForTests();
  const e = createStubEmbedder({ dimension: 1024 });
  const tool = createBeliefTool({ db, embedder: e, catalog: [] });
  const out = await tool.handler({ query: 'anything' });
  assert.equal(out.recommendation, 'unknown');
  assert.equal(out.meta.shadow, true);
  assert.equal(out.meta.fallback_path, 'no_hits');
  await close(db);
});

test('belief tool: shadow override forces unknown, preserves shadow_would_have_been', async () => {
  const db = await fresh();
  // Migration 0021 (cognition-wave-enable) flipped shadow_mode to false; this
  // test asserts in-shadow behavior, so set the precondition explicitly.
  await db.query('UPSERT runtime:`belief.config` SET value.shadow_mode = true').collect();
  _resetBeliefConfigCacheForTests();
  const e = createStubEmbedder({ dimension: 1024 });
  for (const text of ['A about photography', 'B about photography', 'C about photography']) {
    await store.note(db, e, 'knowledge', {
      content: text,
      derived_by: 'auto',
      confidence: 0.9,
    });
  }
  const tool = createBeliefTool({ db, embedder: e, catalog: [] });
  const out = await tool.handler({ query: 'photography', domain: 'photography' });
  assert.equal(out.meta.shadow, true);
  assert.equal(out.recommendation, 'unknown', 'overridden by shadow_mode=true');
  assert.ok(
    ['assert', 'soften', 'unknown'].includes(out.meta.shadow_recommendation_would_have_been),
    `got ${out.meta.shadow_recommendation_would_have_been}`,
  );
  await close(db);
});

test('belief tool: flipped out of shadow -> recommendation reflects the gate', async () => {
  const db = await fresh();
  await db.query('UPDATE runtime:`belief.config` SET value.shadow_mode = false').collect();
  _resetBeliefConfigCacheForTests();
  const e = createStubEmbedder({ dimension: 1024 });
  for (const text of ['A photography', 'B photography', 'C photography']) {
    await store.note(db, e, 'knowledge', {
      content: text,
      derived_by: 'auto',
      confidence: 0.9,
    });
  }
  const tool = createBeliefTool({ db, embedder: e, catalog: [] });
  const out = await tool.handler({ query: 'photography' });
  assert.equal(out.meta.shadow, false);
  assert.ok(['assert', 'soften', 'unknown'].includes(out.recommendation));
  assert.equal(out.meta.shadow_recommendation_would_have_been, undefined);
  await close(db);
});

test('belief tool: input schema has additionalProperties:false and requires query', () => {
  const tool = createBeliefTool({ db: null, embedder: null, catalog: [] });
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.ok(tool.inputSchema.required.includes('query'));
});

test('belief tool: error envelope on internal failure', async () => {
  _resetBeliefConfigCacheForTests();
  const stubDb = {
    query() {
      throw new Error('db down');
    },
  };
  const e = createStubEmbedder({ dimension: 1024 });
  const tool = createBeliefTool({ db: stubDb, embedder: e, catalog: [] });
  const out = await tool.handler({ query: 'anything' });
  assert.equal(out.error, 'belief_internal');
  assert.equal(out.recommendation, 'unknown');
  assert.ok(out.meta);
});
