// tests/unit/comm-style-synthesis.test.js
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createStubEmbedder } from '../../src/embed/embedder.js';
import { getCommStyle, synthesizeCommStyle } from '../../src/jobs/comm-style.js';

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

// Seed a correction event using the same shape record-correction.js writes:
// source='manual', meta.kind='correction'. The synthesis query filters on
// meta.kind = 'correction' (not source = 'correction').
async function seedCorrection(db, embedder, content) {
  const emb = Array.from(await embedder.embed(content));
  const [rows] = await db
    .query(
      surql`CREATE events CONTENT ${{
        source: 'manual',
        content,
        content_hash: `h-${Math.random().toString(36).slice(2)}`,
        meta: { kind: 'correction' },
      }}`,
    )
    .collect();
  return rows[0].id;
}

const stubLLM = (output) => ({ invokeLLM: async () => ({ content: output }) });

test('synthesis — <3 signals persists defaults with confidence 0, no LLM call', async () => {
  const { db, embedder } = await fresh();
  await seedCorrection(db, embedder, 'too brief');
  let llmCalls = 0;
  const host = {
    invokeLLM: async () => {
      llmCalls++;
      return { content: '{}' };
    },
  };
  const r = await synthesizeCommStyle(db, host);
  assert.equal(r.ok, true);
  assert.equal(r.signals_used, 1);
  assert.equal(llmCalls, 0, 'LLM should not be called with <3 signals');
  const persisted = await getCommStyle(db);
  assert.equal(persisted.confidence, 0);
  assert.equal(persisted.tone, 'balanced');
  await close(db);
});

test('synthesis — 3+ signals with valid LLM output persisted', async () => {
  const { db, embedder } = await fresh();
  for (let i = 0; i < 4; i++) {
    await seedCorrection(db, embedder, `correction ${i}: be more terse`);
  }
  const llm = stubLLM(
    JSON.stringify({
      tone: 'terse',
      formality: 'casual',
      emoji_ok: false,
      direct_feedback_ok: true,
      code_comment_density: 'minimal',
      summary_style: 'bullets',
      confidence: 0.8,
      evidence_indices: [1, 2],
    }),
  );
  const r = await synthesizeCommStyle(db, llm);
  assert.equal(r.ok, true);
  assert.equal(r.signals_used, 4);
  const persisted = await getCommStyle(db);
  assert.equal(persisted.tone, 'terse');
  assert.equal(persisted.summary_style, 'bullets');
  assert.equal(persisted.confidence, 0.8);
  assert.equal(persisted.evidence.length, 2, 'two indices resolved to two event ids');
  await close(db);
});

test('synthesis — malformed LLM output leaves previous shape', async () => {
  const { db, embedder } = await fresh();
  for (let i = 0; i < 4; i++) {
    await seedCorrection(db, embedder, `correction ${i}`);
  }
  // First, persist a valid shape via a good LLM
  await synthesizeCommStyle(
    db,
    stubLLM(
      JSON.stringify({
        tone: 'verbose',
        formality: 'formal',
        emoji_ok: true,
        direct_feedback_ok: true,
        code_comment_density: 'moderate',
        summary_style: 'prose',
        confidence: 0.6,
        evidence_indices: [],
      }),
    ),
  );
  // Now, malformed LLM
  const r = await synthesizeCommStyle(db, stubLLM('not json'));
  assert.equal(r.ok, false);
  assert.match(r.reason, /parse_failed|invalid/);
  // Previous shape preserved
  const persisted = await getCommStyle(db);
  assert.equal(persisted.tone, 'verbose');
  await close(db);
});

test('synthesis — invalid LLM shape rejected, previous preserved', async () => {
  const { db, embedder } = await fresh();
  for (let i = 0; i < 4; i++) {
    await seedCorrection(db, embedder, `correction ${i}`);
  }
  // Seed valid
  await synthesizeCommStyle(
    db,
    stubLLM(
      JSON.stringify({
        tone: 'terse',
        formality: 'casual',
        emoji_ok: false,
        direct_feedback_ok: true,
        code_comment_density: 'minimal',
        summary_style: 'bullets',
        confidence: 0.5,
        evidence_indices: [],
      }),
    ),
  );
  // Now bad enum
  const r = await synthesizeCommStyle(
    db,
    stubLLM(
      JSON.stringify({
        tone: 'shouty', // invalid
        formality: 'casual',
        emoji_ok: false,
        direct_feedback_ok: true,
        code_comment_density: 'minimal',
        summary_style: 'bullets',
        confidence: 0.5,
        evidence_indices: [],
      }),
    ),
  );
  assert.equal(r.ok, false);
  const persisted = await getCommStyle(db);
  assert.equal(persisted.tone, 'terse');
  await close(db);
});
