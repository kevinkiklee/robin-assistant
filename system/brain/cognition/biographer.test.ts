import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { LLMDispatcher } from '../llm/dispatcher.ts';
import type { LLMProvider } from '../llm/types.ts';
import { closeDb, openDb } from '../memory/db.ts';
import { upsertEntity } from '../memory/entity.ts';
import { allMigrations, applyMigrations } from '../memory/migrations/index.ts';
import { chunkBody, runBiographer } from './biographer.ts';
import { captureSession } from './capture.ts';

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
  const ents = db.prepare('SELECT canonical_name FROM entities').all() as Array<{
    canonical_name: string;
  }>;
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

test('chunkBody: returns body as single chunk when within limit', () => {
  const body = '[USER]\nshort\n\n[ASSISTANT]\nshort reply';
  assert.deepEqual(chunkBody(body, 1000), [body]);
});

test('chunkBody: splits on turn boundaries when over limit', () => {
  const turn = (role: string, n: number) => `[${role}]\n${'x'.repeat(n)}`;
  const body = [
    turn('USER', 400),
    turn('ASSISTANT', 400),
    turn('USER', 400),
    turn('ASSISTANT', 400),
  ].join('\n\n');
  const chunks = chunkBody(body, 1000);
  assert.ok(chunks.length >= 2, `expected multiple chunks, got ${chunks.length}`);
  // No chunk exceeds the limit
  for (const c of chunks) assert.ok(c.length <= 1000, `chunk too large: ${c.length}`);
  // Every chunk starts with a turn marker
  for (const c of chunks) assert.match(c, /^\[(USER|ASSISTANT|TOOL)\]/);
});

test('chunkBody: slices a single oversized turn rather than dropping it', () => {
  const body = `[USER]\n${'x'.repeat(2500)}`;
  const chunks = chunkBody(body, 1000);
  assert.ok(chunks.length >= 3);
  for (const c of chunks) assert.ok(c.length <= 1000);
});

test('biographer: chunks long sessions and merges entities across chunks (dedup)', async () => {
  const db = freshDb();
  // Build a body just over the threshold so chunking kicks in
  const turn = (role: string, content: string) => `[${role}]\n${content}`;
  const longContent = 'x'.repeat(3000);
  const body = [
    turn('USER', `talking about Lisbon — ${longContent}`),
    turn('ASSISTANT', `Kevin visited Lisbon — ${longContent}`),
    turn('USER', `also Porto — ${longContent}`),
    turn('ASSISTANT', `Kevin liked Porto too — ${longContent}`),
  ].join('\n\n');

  // Different LLM responses per chunk: chunk 1 returns Lisbon, chunk 2 returns Porto + Kevin (duplicate)
  const responses = [
    JSON.stringify({
      entities: [
        { type: 'person', name: 'Kevin' },
        { type: 'place', name: 'Lisbon' },
      ],
      relations: [{ subject: 'Kevin', predicate: 'visited', object: 'Lisbon' }],
    }),
    JSON.stringify({
      entities: [
        { type: 'person', name: 'kevin' }, // case-different duplicate
        { type: 'place', name: 'Porto' },
      ],
      relations: [{ subject: 'Kevin', predicate: 'visited', object: 'Porto' }],
    }),
  ];

  const dispatchLLM = mockLLM('{}');
  let callIdx = 0;
  dispatchLLM.invoke = async (capability, options) => {
    void capability;
    void options;
    const text =
      responses[Math.min(callIdx, responses.length - 1)] ?? responses[responses.length - 1];
    callIdx++;
    return {
      text,
      usage: { inputTokens: 0, outputTokens: 0 },
      costUsd: 0,
      latencyMs: 0,
      provider: 'mock',
    };
  };

  // Insert the long body directly as a session.captured event so we control the size
  const nowIso = new Date().toISOString();
  const contentInfo = db
    .prepare(`INSERT INTO events_content (ts, body) VALUES (?, ?)`)
    .run(nowIso, body);
  db.prepare(
    `INSERT INTO events (ts, kind, source, status, payload, content_ref) VALUES (?, 'session.captured', 'capture', 'ok', '{}', ?)`,
  ).run(nowIso, Number(contentInfo.lastInsertRowid));

  const r = await runBiographer(db, dispatchLLM);
  assert.equal(r.processed, 1);
  assert.ok(callIdx >= 2, `expected at least 2 chunk LLM calls, got ${callIdx}`);

  const ents = db
    .prepare('SELECT canonical_name FROM entities ORDER BY canonical_name')
    .all() as Array<{
    canonical_name: string;
  }>;
  const names = new Set(ents.map((e) => e.canonical_name.toLowerCase()));
  assert.ok(names.has('kevin') || names.has('Kevin'.toLowerCase()), 'Kevin should be present');
  assert.ok(names.has('lisbon'), 'Lisbon should be present');
  assert.ok(names.has('porto'), 'Porto should be present');
  // Kevin should be deduped — only one entity row per canonical name
  const kevinRows = ents.filter((e) => e.canonical_name.toLowerCase() === 'kevin');
  assert.equal(kevinRows.length, 1, 'Kevin should be deduped to one entity');

  closeDb(db);
});

test('biographer: disambiguates between multiple entity candidates via LLM', async () => {
  const db = freshDb();
  // Pre-seed two "Kevin" entities
  const a = upsertEntity(db, 'person', 'Kevin Lee');
  upsertEntity(db, 'person', 'Kevin Chen');
  // LLM extracts "Kevin Lee" — disambiguation should match it
  const disambiguation = JSON.stringify({
    matched_id: a.id,
    create_new: false,
    reason: 'matches context about product engineering',
  });
  const dispatchLLM = mockLLM(JSON.stringify({ entities: [], relations: [] }));
  // Override invoke to return our disambiguation response when asked
  const originalInvoke = dispatchLLM.invoke;
  let invocationCount = 0;
  dispatchLLM.invoke = async (capability, options) => {
    invocationCount++;
    // Second invocation is the disambiguation
    if (invocationCount === 2) {
      return {
        text: disambiguation,
        usage: { inputTokens: 0, outputTokens: 0 },
        costUsd: 0,
        latencyMs: 0,
        provider: 'mock',
      };
    }
    return originalInvoke.call(dispatchLLM, capability, options);
  };
  await captureSession(db, null, {
    sessionId: 's1',
    turns: [
      { role: 'user', content: 'tell me about Kevin Lee' },
      { role: 'assistant', content: 'Kevin Lee is the product engineer.' },
    ],
  });
  const r = await runBiographer(db, dispatchLLM);
  assert.equal(r.processed, 1);
  // Should have matched Kevin Lee (no NEW entity created, just relation references existing)
  const ents = db.prepare('SELECT id, canonical_name FROM entities').all() as Array<{
    id: number;
    canonical_name: string;
  }>;
  assert.equal(ents.length, 2); // still just Kevin Lee and Kevin Chen
  closeDb(db);
});
