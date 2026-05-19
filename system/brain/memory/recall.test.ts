import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb, closeDb } from './db.ts';
import { allMigrations, applyMigrations } from './migrations/index.ts';
import { LLMDispatcher } from '../llm/dispatcher.ts';
import type { LLMProvider } from '../llm/types.ts';
import { ingest } from './ingest.ts';
import { recall } from './recall.ts';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'robin-recall-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

function mockLLM(vec: number[]): LLMDispatcher {
  const provider: LLMProvider = {
    name: 'mock',
    capabilities: new Set(['embed']),
    meta: { contextWindow: 0, inputPricePerM: 0, outputPricePerM: 0 },
    invoke: async () => { throw new Error('nope'); },
    embed: async () => [vec],
  };
  const d = new LLMDispatcher();
  d.register('e', provider);
  d.assign('embed', 'e');
  return d;
}

test('recall: lex mode returns FTS hits', async () => {
  const db = freshDb();
  const llm = mockLLM(new Array(1024).fill(0.1));
  await ingest(db, llm, { kind: 't', source: 's', content: 'kevin loves photography in Lisbon' });
  await ingest(db, llm, { kind: 't', source: 's', content: 'the weather today is sunny' });

  const hits = await recall(db, null, 'Lisbon', { mode: 'lex' });
  assert.equal(hits.length, 1);
  assert.match(hits[0].body, /Lisbon/);
  closeDb(db);
});

test('recall: lex returns empty when no matches', async () => {
  const db = freshDb();
  const hits = await recall(db, null, 'nonexistent', { mode: 'lex' });
  assert.equal(hits.length, 0);
  closeDb(db);
});

test('recall: vec mode finds the row whose embedding the dispatcher returned', async () => {
  const db = freshDb();
  const targetVec = new Array(1024).fill(0.0);
  targetVec[0] = 1.0;
  const llm = mockLLM(targetVec);
  await ingest(db, llm, { kind: 't', source: 's', content: 'kevin loves photography in Lisbon' });
  const hits = await recall(db, llm, 'unrelated query', { mode: 'vec' });
  assert.equal(hits.length, 1);
  assert.match(hits[0].body, /Lisbon/);
  closeDb(db);
});
