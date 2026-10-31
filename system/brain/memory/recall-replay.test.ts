import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { LLMDispatcher } from '../llm/dispatcher.ts';
import type { InvokeRequest, LLMProvider } from '../llm/types.ts';
import { closeDb, openDb } from './db.ts';
import { allMigrations, applyMigrations } from './migrations/index.ts';
import {
  type JudgedHit,
  judgeHits,
  runReplay,
  samplePrompts,
  sweepThresholds,
} from './recall-replay.ts';
import { quantizeToInt8Json } from './vec-quantize.ts';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'robin-replay-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

/** Insert a conversation-shaped event + content row with an explicit ts/kind. */
function insertConversation(
  db: ReturnType<typeof freshDb>,
  kind: string,
  ts: string,
  body: string,
): number {
  const c = db.prepare(`INSERT INTO events_content (ts, body) VALUES (?, ?)`).run(ts, body);
  const e = db
    .prepare(
      `INSERT INTO events (ts, kind, source, status, payload, content_ref)
       VALUES (?, ?, 'capture', 'ok', '{}', ?)`,
    )
    .run(ts, kind, Number(c.lastInsertRowid));
  return Number(e.lastInsertRowid);
}

function hoursAgo(h: number): string {
  return new Date(Date.now() - h * 3_600_000).toISOString();
}

/** Dispatcher stub: 'classify' returns fixed text (or throws); 'embed' returns a fixed vector. */
function stubLLM(opts: {
  classifyText?: string;
  classifyThrows?: boolean;
  embedVec?: number[];
  seen?: InvokeRequest[];
}): LLMDispatcher {
  const provider: LLMProvider = {
    name: 'mock',
    capabilities: new Set(['classify', 'embed']),
    meta: { contextWindow: 8000, inputPricePerM: 0, outputPricePerM: 0 },
    invoke: async (req) => {
      opts.seen?.push(req);
      if (opts.classifyThrows) throw new Error('judge outage');
      return {
        text: opts.classifyText ?? '',
        usage: { inputTokens: 0, outputTokens: 0 },
        costUsd: 0,
        latencyMs: 0,
        provider: 'mock',
      };
    },
    embed: async () => [opts.embedVec ?? new Array(3072).fill(0)],
  };
  const d = new LLMDispatcher();
  d.register('m', provider);
  d.assign('classify', 'm');
  d.assign('embed', 'm');
  return d;
}

// ─── sweepThresholds ──────────────────────────────────────────────────────────

test('sweepThresholds: precision + recallOfRelevant per threshold, including a zero-keep row', () => {
  const mk = (contentId: number, distance: number, relevant: boolean): JudgedHit => ({
    contentId,
    distance,
    relevant,
  });
  const judged = [
    { prompt: 'a', hits: [mk(1, 0.7, true), mk(2, 0.8, false), mk(3, 0.9, true)] },
    { prompt: 'b', hits: [mk(4, 0.75, true), mk(5, 0.85, false)] },
  ];
  // 3 relevant pairs total across both prompts — the recallOfRelevant denominator.
  const rows = sweepThresholds(judged, [0.5, 0.72, 0.78, 0.86, 0.95]);
  assert.deepEqual(rows, [
    { maxDistance: 0.5, kept: 0, keptRelevant: 0, precision: 0, recallOfRelevant: 0 },
    { maxDistance: 0.72, kept: 1, keptRelevant: 1, precision: 1, recallOfRelevant: 1 / 3 },
    { maxDistance: 0.78, kept: 2, keptRelevant: 2, precision: 1, recallOfRelevant: 2 / 3 },
    { maxDistance: 0.86, kept: 4, keptRelevant: 2, precision: 0.5, recallOfRelevant: 2 / 3 },
    { maxDistance: 0.95, kept: 5, keptRelevant: 3, precision: 3 / 5, recallOfRelevant: 1 },
  ]);
});

test('sweepThresholds: empty judged set yields all-zero rows (no NaN from 0/0)', () => {
  const rows = sweepThresholds([], [0.82]);
  assert.deepEqual(rows, [
    { maxDistance: 0.82, kept: 0, keptRelevant: 0, precision: 0, recallOfRelevant: 0 },
  ]);
});

// ─── judgeHits ────────────────────────────────────────────────────────────────

test('judgeHits: valid strict JSON flags the numbered hits; excerpts are truncated to 500', async () => {
  const seen: InvokeRequest[] = [];
  const llm = stubLLM({ classifyText: '{"relevant":[1,3]}', seen });
  const longBody = `needle-head ${'x'.repeat(600)}tail-marker`;
  const hits = [
    { contentId: 11, distance: 0.7, kind: 'belief.update', body: longBody },
    { contentId: 12, distance: 0.8, body: 'trail conditions on the North Ridge' },
    { contentId: 13, distance: 0.9, body: 'bike chain service notes' },
  ];
  const judged = await judgeHits(llm, 'what should I bring to Lakeport Hills?', hits);
  assert.deepEqual(
    judged.map((j) => j.relevant),
    [true, false, true],
  );
  // contentId/distance/kind pass through untouched.
  assert.deepEqual(
    judged.map((j) => j.contentId),
    [11, 12, 13],
  );
  assert.deepEqual(
    judged.map((j) => j.distance),
    [0.7, 0.8, 0.9],
  );
  assert.equal(judged[0].kind, 'belief.update');
  // ONE classify call for the whole prompt.
  assert.equal(seen.length, 1);
  const sent = `${seen[0].systemPrompt ?? ''}\n${seen[0].messages.map((m) => m.content).join('\n')}`;
  assert.ok(sent.includes('needle-head'), 'excerpt head must be in the judge prompt');
  assert.ok(!sent.includes('tail-marker'), 'body beyond 500 chars must be truncated away');
});

test('judgeHits: malformed judge output → all-false, never throws', async () => {
  const llm = stubLLM({ classifyText: 'sure! the relevant ones are 1 and 2' });
  const judged = await judgeHits(llm, 'prompt', [
    { contentId: 1, distance: 0.7, body: 'a' },
    { contentId: 2, distance: 0.8, body: 'b' },
  ]);
  assert.deepEqual(
    judged.map((j) => j.relevant),
    [false, false],
  );
});

test('judgeHits: a throwing dispatcher → all-false, never throws', async () => {
  const llm = stubLLM({ classifyThrows: true });
  const judged = await judgeHits(llm, 'prompt', [{ contentId: 1, distance: 0.7, body: 'a' }]);
  assert.deepEqual(
    judged.map((j) => j.relevant),
    [false],
  );
});

test('judgeHits: onError observes a dispatcher throw; observer bugs are contained', async () => {
  const llm = stubLLM({ classifyThrows: true });
  const errors: unknown[] = [];
  await judgeHits(llm, 'prompt', [{ contentId: 1, distance: 0.7, body: 'a' }], {
    onError: (e) => {
      errors.push(e);
      throw new Error('observer bug');
    },
  });
  assert.equal(errors.length, 1);

  // A clean judge never invokes onError.
  const cleanErrors: unknown[] = [];
  const cleanLlm = stubLLM({ classifyText: '{"relevant":[1]}' });
  const judged = await judgeHits(cleanLlm, 'prompt', [{ contentId: 1, distance: 0.7, body: 'a' }], {
    onError: (e) => cleanErrors.push(e),
  });
  assert.deepEqual(
    judged.map((j) => j.relevant),
    [true],
  );
  assert.equal(cleanErrors.length, 0);
});

test('judgeHits: zero hits → empty result with no LLM call', async () => {
  const seen: InvokeRequest[] = [];
  const llm = stubLLM({ classifyText: '{"relevant":[]}', seen });
  const judged = await judgeHits(llm, 'prompt', []);
  assert.deepEqual(judged, []);
  assert.equal(seen.length, 0);
});

// ─── samplePrompts ────────────────────────────────────────────────────────────

const USER_PROMPT_A =
  'Which boots should I bring for the ridge trail at Lakeport Hills this weekend?';
const USER_PROMPT_B = 'How do I clean the bike chain without a degreaser?';

test('samplePrompts: extracts user-side turns from captured bodies, newest first', () => {
  const db = freshDb();
  insertConversation(
    db,
    'session.captured',
    hoursAgo(2),
    `[USER]\n${USER_PROMPT_A}\n\n[ASSISTANT]\nBring the Acme X1 boots and a spare pair of laces.`,
  );
  insertConversation(
    db,
    'session.captured',
    hoursAgo(1),
    `[USER]\n${USER_PROMPT_B}\n\n[ASSISTANT]\nUse a dry rag and a light chain oil.`,
  );
  const samples = samplePrompts(db);
  assert.equal(samples.length, 2);
  assert.equal(samples[0].prompt, USER_PROMPT_B); // newest first
  assert.equal(samples[1].prompt, USER_PROMPT_A);
  assert.ok(
    samples.every((s) => !/Acme X1|chain oil/.test(s.prompt)),
    'assistant-side text must never leak into prompts',
  );
  assert.ok(samples.every((s) => typeof s.eventId === 'number' && typeof s.ts === 'string'));
  closeDb(db);
});

test('samplePrompts: drops user turns under 40 chars', () => {
  const db = freshDb();
  insertConversation(
    db,
    'session.captured',
    hoursAgo(1),
    `[USER]\nok thanks\n\n[ASSISTANT]\nYou are welcome.\n\n[USER]\n${USER_PROMPT_A}`,
  );
  const samples = samplePrompts(db);
  assert.equal(samples.length, 1);
  assert.equal(samples[0].prompt, USER_PROMPT_A);
  closeDb(db);
});

test('samplePrompts: turns not separable → leading 2000 chars of the body', () => {
  const db = freshDb();
  // v2-imported conversation.claude-code bodies are raw text with no [USER] markers.
  const body = `raw v2 conversation about the garden plan ${'z'.repeat(2500)}`;
  insertConversation(db, 'conversation.claude-code', hoursAgo(1), body);
  const samples = samplePrompts(db);
  assert.equal(samples.length, 1);
  assert.equal(samples[0].prompt.length, 2000); // recall truncates its embed input identically
  assert.equal(samples[0].prompt, body.slice(0, 2000));
  closeDb(db);
});

test('samplePrompts: dedupes repeat prompts by query hash', () => {
  const db = freshDb();
  insertConversation(db, 'session.captured', hoursAgo(2), `[USER]\n${USER_PROMPT_A}`);
  insertConversation(db, 'session.captured', hoursAgo(1), `[USER]\n${USER_PROMPT_A}`);
  const samples = samplePrompts(db);
  assert.equal(samples.length, 1);
  closeDb(db);
});

test('samplePrompts: respects limit and sinceDays; ignores non-conversation kinds', () => {
  const db = freshDb();
  insertConversation(db, 'session.captured', hoursAgo(24 * 40), `[USER]\n${USER_PROMPT_A}`);
  insertConversation(db, 'session.captured', hoursAgo(2), `[USER]\n${USER_PROMPT_B}`);
  insertConversation(
    db,
    'belief.update',
    hoursAgo(1),
    `[USER]\nthis is not a conversation event and must not be sampled at all`,
  );
  const beyondWindow = samplePrompts(db, { sinceDays: 30 });
  assert.equal(beyondWindow.length, 1, '40-day-old event is outside the window');
  assert.equal(beyondWindow[0].prompt, USER_PROMPT_B);

  const widened = samplePrompts(db, { sinceDays: 60 });
  assert.equal(widened.length, 2);
  const limited = samplePrompts(db, { sinceDays: 60, limit: 1 });
  assert.equal(limited.length, 1);
  assert.equal(limited[0].prompt, USER_PROMPT_B, 'limit keeps the newest');
  closeDb(db);
});

// ─── runReplay (stubbed end-to-end wiring) ────────────────────────────────────

test('runReplay: samples → vec recall → one judge pass → sweep (distance = 1 - score)', async () => {
  const db = freshDb();
  insertConversation(db, 'session.captured', hoursAgo(1), `[USER]\n${USER_PROMPT_A}`);

  // Seed one vec-indexed memory row that embeds identically to the query (distance 0).
  const vec = new Array(3072).fill(0);
  const half = 1536;
  for (let i = 0; i < half; i++) vec[i] = 1 / Math.sqrt(half);
  const c = db
    .prepare(`INSERT INTO events_content (ts, body, embedding) VALUES (?, ?, ?)`)
    .run(hoursAgo(3), 'North Ridge trail conditions in early spring', Buffer.from([1]));
  const contentId = Number(c.lastInsertRowid);
  db.prepare(
    `INSERT INTO events (ts, kind, source, status, payload, content_ref)
     VALUES (?, 'memory.remember', 's', 'ok', '{}', ?)`,
  ).run(hoursAgo(3), contentId);
  db.prepare(`INSERT INTO events_vec(rowid, embedding) VALUES (?, vec_int8(?))`).run(
    BigInt(contentId),
    quantizeToInt8Json(vec),
  );

  const seen: InvokeRequest[] = [];
  const llm = stubLLM({ classifyText: '{"relevant":[1]}', embedVec: vec, seen });
  const report = await runReplay(db, llm, { promptLimit: 5 });

  assert.equal(report.samples, 1);
  assert.equal(report.judgedPairs, 1);
  assert.equal(report.judgeFailures, 0);
  assert.equal(seen.length, 1, 'exactly one judge call per prompt');
  assert.equal(report.sweep.length, 12);
  assert.equal(report.sweep[0].maxDistance, 0.72);
  assert.equal(report.sweep[11].maxDistance, 0.94);
  // The identical-embedding hit has distance 0 → kept + relevant at every threshold.
  for (const row of report.sweep) {
    assert.equal(row.kept, 1);
    assert.equal(row.keptRelevant, 1);
    assert.equal(row.precision, 1);
    assert.equal(row.recallOfRelevant, 1);
  }
  closeDb(db);
});
