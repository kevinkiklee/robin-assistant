// cascade-compose.test.js — tests the new entity-resolution cascade composer
// in src/graph/upsert-entity.js (the post-redesign replacement for the deleted
// src/graph/cascade.js). Confirms stage short-circuits and host wiring.

import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import { test } from 'node:test';
import { upsertEntityCascade } from '../../cognition/biographer/upsert-entity.js';
import { writeConfig as __robinWriteConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createStubEmbedder } from '../../data/embed/embedder.js';

// __robin_test_home_setup__
const __robinTestHome = __robinJoin(
  __robinTmpdir(),
  `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
);
__robinMkdirSync(__robinTestHome, { recursive: true });
process.env.ROBIN_HOME = __robinTestHome;
await __robinWriteConfig({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  return db;
}

test('Stage 1 hit short-circuits — host.invokeLLM never called', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  // Seed an existing entity. upsertEntityCascade uses name_lower for the
  // stage-1 lookup, so 'Alice' matches a lowercase query 'alice'.
  await upsertEntityCascade(db, e, { name: 'Alice', type: 'person' });
  const fakeHost = {
    invokeLLM: async () => {
      throw new Error('should not be called');
    },
  };
  const r = await upsertEntityCascade(db, e, {
    name: 'alice',
    type: 'person',
    host: fakeHost,
    config: { stage2_high_threshold: 0.92, stage2_low_threshold: 0.8 },
  });
  assert.equal(r.stage, 1);
  assert.equal(r.created, false);
  await close(db);
});

test('Stage 1 hit returns existing id without LLM call', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const first = await upsertEntityCascade(db, e, { name: 'AliceMixed', type: 'person' });
  let stage3Called = false;
  const fakeHost = {
    invokeLLM: async () => {
      stage3Called = true;
      return { content: '{"pick":null}', usage: {} };
    },
  };
  const r = await upsertEntityCascade(db, e, {
    name: 'AliceMixed',
    type: 'person',
    host: fakeHost,
    config: { stage2_high_threshold: 0.92, stage2_low_threshold: 0.8 },
  });
  assert.equal(String(r.id), String(first.id));
  assert.equal(stage3Called, false);
  await close(db);
});

test('All stages miss → creates new entity (stage 0)', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const fakeHost = {
    invokeLLM: async () => ({ content: '{"pick":null}', usage: {} }),
  };
  const r = await upsertEntityCascade(db, e, {
    name: 'TotallyNew',
    type: 'person',
    host: fakeHost,
    config: { stage2_high_threshold: 0.92, stage2_low_threshold: 0.8 },
  });
  // The redesign's cascade always creates when no stage resolves — stage 0
  // signals the create path (vs stage 1/2/3 returning a hit).
  assert.equal(r.created, true);
  assert.equal(r.stage, 0);
  await close(db);
});
