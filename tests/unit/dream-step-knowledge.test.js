import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { recordEvent } from '../../src/capture/record-event.js';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { dreamStepKnowledge } from '../../src/dream/step-knowledge.js';
import { createStubEmbedder } from '../../src/embed/embedder.js';

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
  const e = createStubEmbedder({ dimension: 384 });
  const host = fakeHost('{}');
  const r = await dreamStepKnowledge(db, host, e, { minSignals: 3 });
  assert.equal(r.promoted, 0);
  await close(db);
});

test('dreamStepKnowledge promotes when LLM says promote', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 384 });
  const v = Array.from(await e.embed('person: Alice'));
  const [created] = await db
    .query(surql`CREATE entities CONTENT ${{ name: 'Alice', type: 'person', embedding: v }}`)
    .collect();
  const aliceId = (Array.isArray(created) ? created[0] : created).id;
  for (let i = 0; i < 3; i++) {
    const evt = await recordEvent(db, e, {
      source: 'cli',
      content: `event mentioning Alice ${i}`,
    });
    await db.query(surql`RELATE ${evt.id}->mentions->${aliceId}`).collect();
  }
  const host = fakeHost(
    JSON.stringify({ promote: true, knowledge_text: 'Alice is a colleague', confidence: 0.9 }),
  );
  const r = await dreamStepKnowledge(db, host, e, { minSignals: 3 });
  assert.equal(r.promoted, 1);
  await close(db);
});
