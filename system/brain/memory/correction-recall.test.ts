import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { LLMDispatcher } from '../llm/dispatcher.ts';
import type { LLMProvider } from '../llm/types.ts';
import {
  correctionEmbedText,
  embedPendingCorrections,
  isBehavioralCorrection,
  selectRelevantCorrections,
} from './correction-recall.ts';
import { closeDb, openDb, type RobinDb } from './db.ts';
import { allMigrations, applyMigrations } from './migrations/index.ts';

function freshDb(): RobinDb {
  const dir = mkdtempSync(join(tmpdir(), 'robin-corr-recall-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

/** Embeds each input to a vector chosen by `pick(text)`; counts inputs embedded. */
function mockLLM(pick: (text: string) => number[]) {
  const calls: string[][] = [];
  const provider: LLMProvider = {
    name: 'mock',
    capabilities: new Set(['embed']),
    meta: { contextWindow: 0, inputPricePerM: 0, outputPricePerM: 0 },
    invoke: async () => {
      throw new Error('no invoke');
    },
    embed: async (texts: string | string[]) => {
      const arr = Array.isArray(texts) ? texts : [texts];
      calls.push(arr);
      return arr.map(pick);
    },
  };
  const d = new LLMDispatcher();
  d.register('e', provider);
  d.assign('embed', 'e');
  return { llm: d, calls };
}

function addCorrection(db: RobinDb, what: string, correction: string): number {
  return Number(
    db.prepare('INSERT INTO corrections (what, correction) VALUES (?, ?)').run(what, correction)
      .lastInsertRowid,
  );
}

const FLIGHT = [1, 0, 0];
const OTHER = [0, 1, 0];
const pickByTopic = (t: string) => (/flight/i.test(t) ? FLIGHT : OTHER);

test('migration 040: correction_embeddings exists and cascades with its correction', () => {
  const db = freshDb();
  const id = addCorrection(db, 'w', 'c');
  db.prepare(
    `INSERT INTO correction_embeddings (correction_id, text_sha, embedding, embedded_at) VALUES (?, 'x', x'00', 't')`,
  ).run(id);
  db.prepare('DELETE FROM corrections WHERE id = ?').run(id);
  const n = db.prepare('SELECT COUNT(*) AS n FROM correction_embeddings').get() as { n: number };
  assert.equal(n.n, 0);
  closeDb(db);
});

test('embedPendingCorrections: embeds missing rows once, re-embeds only edited ones', async () => {
  const db = freshDb();
  const a = addCorrection(db, 'Robin pitched a 6am flight', 'Sam does not want early flights.');
  addCorrection(db, 'Robin said X2', 'It is the X1.');
  const { llm, calls } = mockLLM(pickByTopic);

  const first = await embedPendingCorrections(db, llm);
  assert.deepEqual(first, { embedded: 2, failed: 0, pending: 0 });
  assert.equal(calls.length, 1, 'one batched embed call');

  const again = await embedPendingCorrections(db, llm);
  assert.deepEqual(again, { embedded: 0, failed: 0, pending: 0 });
  assert.equal(calls.length, 1, 'nothing re-embedded when text is unchanged');

  db.prepare('UPDATE corrections SET correction = ? WHERE id = ?').run(
    'No early flights, ever.',
    a,
  );
  const edited = await embedPendingCorrections(db, llm);
  assert.equal(edited.embedded, 1);
  assert.deepEqual(calls[1], [
    correctionEmbedText({
      what: 'Robin pitched a 6am flight',
      correction: 'No early flights, ever.',
    }),
  ]);
  closeDb(db);
});

test('embedPendingCorrections: an embed failure leaves rows pending, never throws', async () => {
  const db = freshDb();
  addCorrection(db, 'w', 'c');
  const provider: LLMProvider = {
    name: 'mock',
    capabilities: new Set(['embed']),
    meta: { contextWindow: 0, inputPricePerM: 0, outputPricePerM: 0 },
    invoke: async () => {
      throw new Error('no');
    },
    embed: async () => {
      throw new Error('provider down');
    },
  };
  const d = new LLMDispatcher();
  d.register('e', provider);
  d.assign('embed', 'e');
  const res = await embedPendingCorrections(db, d);
  assert.deepEqual(res, { embedded: 0, failed: 1, pending: 1 });
  closeDb(db);
});

test('selectRelevantCorrections: returns only corrections above the floor, best first', async () => {
  const db = freshDb();
  const early = addCorrection(db, 'Robin pitched a 6am flight', 'Sam does not want early flights.');
  addCorrection(db, 'Robin said X2', 'It is the X1.');
  await embedPendingCorrections(db, mockLLM(pickByTopic).llm);

  const hits = selectRelevantCorrections(db, FLIGHT);
  assert.deepEqual(
    hits.map((h) => h.id),
    [early],
  );
  assert.ok(hits[0].similarity > 0.99);
  assert.deepEqual(selectRelevantCorrections(db, [0, 0, 1]), [], 'unrelated prompt → nothing');
  closeDb(db);
});

test('selectRelevantCorrections: cap, similarity window, and near-duplicate collapse', async () => {
  const db = freshDb();
  const vecs: Record<string, number[]> = {
    a: [1, 0, 0],
    b: [0.95, 0.3122, 0], // cos ≈ 0.95 → inside the 0.05 window
    dup: [0.95, 0.3122, 0], // same text as b → collapses
    c: [0.8, 0.6, 0], // cos 0.80 → above the floor but outside the window
  };
  const ids: Record<string, number> = {};
  ids.a = addCorrection(db, 'a', 'rule a');
  ids.b = addCorrection(db, 'b', 'rule b');
  ids.dup = addCorrection(db, 'dup', 'rule b');
  ids.c = addCorrection(db, 'c', 'rule c');
  const { llm } = mockLLM((t) => vecs[t.split('\n')[0]]);
  await embedPendingCorrections(db, llm);

  const hits = selectRelevantCorrections(db, [1, 0, 0]);
  assert.equal(hits.length, 2, 'c is outside the window; b/dup collapse to one');
  assert.equal(hits[0].id, ids.a);
  assert.ok([ids.b, ids.dup].includes(hits[1].id));
  assert.equal(selectRelevantCorrections(db, [1, 0, 0], { cap: 1 }).length, 1);
  assert.equal(selectRelevantCorrections(db, [1, 0, 0], { window: 1 }).length, 3);
  closeDb(db);
});

test('isBehavioralCorrection: standing rules vs one-off factual fixes', () => {
  assert.equal(isBehavioralCorrection('Never suggest the escape room again.'), true);
  assert.equal(isBehavioralCorrection('Sam does NOT want meetings before 10am.'), true);
  assert.equal(isBehavioralCorrection("Don't recommend the Acme kettle again."), true);
  assert.equal(isBehavioralCorrection('The book club meeting is Tuesday, not Thursday.'), false);
  assert.equal(isBehavioralCorrection('The office printer takes the 85X toner cartridge.'), false);
});
