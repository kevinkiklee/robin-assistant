import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { recordEvent } from '../../io/capture/record-event.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { dreamStepKnowledge } from '../../cognition/dream/step-knowledge.js';
import { createStubEmbedder } from '../../data/embed/embedder.js';
import * as store from '../../cognition/memory/store.js';
import { writeConfig as __robinWriteConfig } from '../../config/paths.js';

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
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return db;
}

function fakeHost(content) {
  return { invokeLLM: async () => ({ content, usage: {} }) };
}

test('dreamStepKnowledge returns 0 promoted when no eligible entities', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const host = fakeHost('{}');
  const r = await dreamStepKnowledge(db, host, e, { minSignals: 3 });
  assert.equal(r.promoted, 0);
  await close(db);
});

test('dreamStepKnowledge promotes when LLM says promote', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const [created] = await db
    .query(surql`CREATE entities CONTENT ${{ name: 'Alice', type: 'person' }}`)
    .collect();
  const aliceId = (Array.isArray(created) ? created[0] : created).id;
  for (let i = 0; i < 3; i++) {
    const evt = await recordEvent(db, e, {
      source: 'cli',
      content: `event mentioning Alice ${i}`,
    });
    await store.relate(db, evt.id, aliceId, 'mentions');
  }
  const host = fakeHost(
    JSON.stringify({ promote: true, knowledge_text: 'Alice is a colleague', confidence: 0.9 }),
  );
  const r = await dreamStepKnowledge(db, host, e, { minSignals: 3 });
  assert.equal(r.promoted, 1);
  await close(db);
});
