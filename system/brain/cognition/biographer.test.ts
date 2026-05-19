import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb, closeDb } from '../memory/db.ts';
import { allMigrations, applyMigrations } from '../memory/migrations/index.ts';
import { LLMDispatcher } from '../llm/dispatcher.ts';
import type { LLMProvider } from '../llm/types.ts';
import { captureSession } from './capture.ts';
import { runBiographer } from './biographer.ts';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'robin-bio-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

function mockLLM(extractJson: string): LLMDispatcher {
  const p: LLMProvider = {
    name: 'mock',
    capabilities: new Set(['reasoning']),
    meta: { contextWindow: 8000, inputPricePerM: 0, outputPricePerM: 0 },
    invoke: async () => ({
      text: extractJson,
      usage: { inputTokens: 0, outputTokens: 0 },
      costUsd: 0,
      latencyMs: 0,
      provider: 'mock',
    }),
  };
  const d = new LLMDispatcher();
  d.register('m', p);
  d.assign('reasoning', 'm');
  return d;
}

test('biographer: no captures → no work', async () => {
  const db = freshDb();
  const r = await runBiographer(db, null);
  assert.equal(r.processed, 0);
  closeDb(db);
});

test('biographer: processes captured session and writes entities + relations', async () => {
  const db = freshDb();
  const llm = mockLLM(
    JSON.stringify({
      entities: [
        { type: 'person', name: 'Kevin' },
        { type: 'place', name: 'Lisbon' },
      ],
      relations: [{ subject: 'Kevin', predicate: 'visited', object: 'Lisbon' }],
    }),
  );
  await captureSession(db, null, {
    sessionId: 's1',
    turns: [
      { role: 'user', content: 'what about my Lisbon trip' },
      { role: 'assistant', content: 'Kevin visited Lisbon in March; really enjoyed the food.' },
    ],
  });
  const r = await runBiographer(db, llm);
  assert.equal(r.processed, 1);
  assert.equal(r.entitiesCreated, 2);
  assert.equal(r.relationsCreated, 1);
  const ents = db.prepare('SELECT canonical_name FROM entities').all() as Array<{ canonical_name: string }>;
  assert.ok(ents.some((e) => e.canonical_name === 'Kevin'));
  assert.ok(ents.some((e) => e.canonical_name === 'Lisbon'));
  closeDb(db);
});

test('biographer: tolerates ```json fenced output (the v2 bug fix)', async () => {
  const db = freshDb();
  const llm = mockLLM(
    '```json\n' +
      JSON.stringify({ entities: [{ type: 'person', name: 'Sarah' }], relations: [] }) +
      '\n```',
  );
  await captureSession(db, null, {
    sessionId: 's1',
    turns: [
      { role: 'user', content: 'tell me about Sarah' },
      { role: 'assistant', content: 'Sarah is a friend.' },
    ],
  });
  const r = await runBiographer(db, llm);
  assert.equal(r.processed, 1);
  assert.equal(r.entitiesCreated, 1);
  closeDb(db);
});

test('biographer: does NOT reprocess events it already handled (idempotent)', async () => {
  const db = freshDb();
  const llm = mockLLM(JSON.stringify({ entities: [{ type: 'person', name: 'X' }], relations: [] }));
  await captureSession(db, null, {
    sessionId: 's1',
    turns: [
      { role: 'user', content: 'tell me about X' },
      { role: 'assistant', content: 'X is a person.' },
    ],
  });
  await runBiographer(db, llm);
  const r2 = await runBiographer(db, llm);
  assert.equal(r2.processed, 0);
  closeDb(db);
});
