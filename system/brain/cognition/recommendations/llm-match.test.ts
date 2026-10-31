import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { LLMDispatcher } from '../../llm/dispatcher.ts';
import type { InvokeRequest, InvokeResult, LLMProvider } from '../../llm/types.ts';
import { closeDb, openDb, type RobinDb } from '../../memory/db.ts';
import { ingest } from '../../memory/ingest.ts';
import { allMigrations, applyMigrations } from '../../memory/migrations/index.ts';
import { runRecommendationLlmMatch, userTurns } from './llm-match.ts';
import { getRecommendation, insertRecommendation } from './store.ts';

function freshDb(): RobinDb {
  const dir = mkdtempSync(join(tmpdir(), 'robin-rec-llm-match-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

const NOW = new Date('2026-10-03T12:00:00.000Z');

/** A `classify` dispatcher returning `judge(prompt)`; records every prompt it saw. */
function mockClassify(
  judge: (prompt: string) => unknown,
  costUsd = 0.01,
): { llm: LLMDispatcher; prompts: string[] } {
  const prompts: string[] = [];
  const provider: LLMProvider = {
    name: 'mock',
    capabilities: new Set(['classify']),
    meta: { contextWindow: 200_000, inputPricePerM: 0, outputPricePerM: 0 },
    invoke: async (req: InvokeRequest): Promise<InvokeResult> => {
      const content = String(req.messages[0]?.content ?? '');
      prompts.push(content);
      return {
        text: '',
        structured: judge(content),
        usage: { inputTokens: 0, outputTokens: 0 },
        costUsd,
        latencyMs: 0,
        provider: 'mock',
      };
    },
  };
  const llm = new LLMDispatcher();
  llm.register('mock', provider);
  llm.assign('classify', 'mock');
  return { llm, prompts };
}

function rec(db: RobinDb, subject: string, verdict: 'buy' | 'try' | 'skip' | 'avoid'): number {
  const { id } = insertRecommendation(db, {
    subject,
    claim: `${verdict} ${subject}`,
    verdict,
    domain: 'home',
  });
  db.prepare(`UPDATE recommendations SET created_at = ? WHERE id = ?`).run(
    '2026-09-20 00:00:00',
    id,
  );
  return id;
}

function session(db: RobinDb, body: string, ts = '2026-09-28T10:00:00.000Z'): number {
  const { eventId } = ingest(db, null, {
    kind: 'session.captured',
    source: 'capture',
    content: body,
    payload: { category: 'personal' },
  });
  db.prepare(`UPDATE events SET ts = ? WHERE id = ?`).run(ts, eventId);
  return eventId;
}

test('userTurns keeps only the operator turns, minus harness scaffolding', () => {
  const body = [
    '[USER]\n<command-name>/clear</command-name>',
    '[USER]\nI ordered the bread box',
    '[ASSISTANT]\nGreat, the Acme Bread Box is a good pick',
    '[TOOL]\n{"ok":true}',
  ].join('\n\n');
  assert.deepEqual(userTurns(body), ['I ordered the bread box']);
});

test('no LLM → skipped, nothing resolved', async () => {
  const db = freshDb();
  const id = rec(db, 'Acme Bread Box', 'buy');
  const res = await runRecommendationLlmMatch(db, null, { now: NOW });
  assert.equal(res.skipped, true);
  assert.equal(getRecommendation(db, id)?.status, 'open');
  closeDb(db);
});

test('did_it on a buy rec with cited operator turn → acted + recommendation_acted emitted', async () => {
  const db = freshDb();
  const id = rec(db, 'Acme Bread Box', 'buy');
  const sid = session(db, '[USER]\nfyi I ordered the acme bread box last night');
  const { llm, prompts } = mockClassify(() => ({
    judgments: [
      { rec: id, outcome: 'did_it', confidence: 0.92, evidence: 'I ordered…', eventId: sid },
    ],
  }));
  const res = await runRecommendationLlmMatch(db, llm, { now: NOW });
  assert.equal(res.acted, 1);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /user: fyi I ordered the acme bread box/);
  assert.ok(!prompts[0].includes('<untrusted-content'), "the operator's own turns stay unfenced");
  const r = getRecommendation(db, id);
  assert.equal(r?.status, 'acted');
  assert.match(r?.evidence ?? '', /llm match \(event #\d+\)/);
  const n = db
    .prepare(`SELECT count(*) AS n FROM events WHERE kind = 'behavior.recommendation_acted'`)
    .get() as { n: number };
  assert.equal(n.n, 1);
  closeDb(db);
});

test('hold stances map through the verdict: did_it → declined (contrary), declined_it → held', async () => {
  const db = freshDb();
  const skipId = rec(db, 'Pine Ridge Trail', 'skip');
  const avoidId = rec(db, 'Sigma Fp camera body', 'avoid');
  const sid = session(
    db,
    '[USER]\nwe ended up hiking pine ridge trail anyway\n\n[USER]\nyeah not getting the sigma fp, agreed',
  );
  const { llm } = mockClassify(() => ({
    judgments: [
      { rec: skipId, outcome: 'did_it', confidence: 0.9, evidence: 'hiked it', eventId: sid },
      {
        rec: avoidId,
        outcome: 'declined_it',
        confidence: 0.9,
        evidence: 'not getting',
        eventId: sid,
      },
    ],
  }));
  const res = await runRecommendationLlmMatch(db, llm, { now: NOW });
  assert.equal(res.declined, 1);
  assert.equal(res.held, 1);
  assert.equal(getRecommendation(db, skipId)?.status, 'declined');
  assert.equal(getRecommendation(db, avoidId)?.status, 'held');
  closeDb(db);
});

test('conservative: low confidence, unclear, and invented event ids leave recs open', async () => {
  const db = freshDb();
  const a = rec(db, 'Alpha Widget Prime', 'buy');
  const b = rec(db, 'Beta Gizmo Deluxe', 'buy');
  const c = rec(db, 'Gamma Doohickey Ultra', 'buy');
  const sid = session(
    db,
    '[USER]\nthinking about alpha widget prime\n\n[USER]\nbeta gizmo deluxe looks nice\n\n[USER]\ngot the gamma doohickey ultra',
  );
  const { llm } = mockClassify(() => ({
    judgments: [
      { rec: a, outcome: 'did_it', confidence: 0.5, evidence: '', eventId: sid },
      { rec: b, outcome: 'unclear', confidence: 0.95, evidence: '' },
      { rec: c, outcome: 'did_it', confidence: 0.95, evidence: '', eventId: 999_999 },
    ],
  }));
  const res = await runRecommendationLlmMatch(db, llm, { now: NOW });
  assert.equal(res.candidates, 3);
  assert.equal(res.acted, 0);
  for (const id of [a, b, c]) assert.equal(getRecommendation(db, id)?.status, 'open');
  closeDb(db);
});

test('recs without evidence are never sent; evidence older than the rec is ignored; assistant turns are not evidence', async () => {
  const db = freshDb();
  const id = rec(db, 'Acme Bread Box', 'buy');
  // Before the rec was made.
  session(db, '[USER]\nordered the acme bread box', '2026-09-10T10:00:00.000Z');
  // Robin restating its advice.
  session(db, '[ASSISTANT]\nYou should buy the Acme Bread Box');
  const { llm, prompts } = mockClassify(() => ({ judgments: [] }));
  const res = await runRecommendationLlmMatch(db, llm, { now: NOW });
  assert.equal(res.candidates, 0);
  assert.equal(prompts.length, 0);
  assert.equal(getRecommendation(db, id)?.status, 'open');
  closeDb(db);
});

test('order email evidence is shown to the judge; batches stop at the budget', async () => {
  const db = freshDb();
  const ids = ['Alpha Widget Prime', 'Beta Gizmo Deluxe'].map((s) => rec(db, s, 'buy'));
  for (const s of ['Alpha Widget Prime', 'Beta Gizmo Deluxe']) {
    const { eventId } = ingest(db, null, {
      kind: 'integration.gmail.message',
      source: 'gmail',
      content: `Your order: ${s}`,
      payload: { subject: 'Your order has shipped!' },
    });
    db.prepare(`UPDATE events SET ts = ? WHERE id = ?`).run('2026-09-29T10:00:00.000Z', eventId);
  }
  const { llm, prompts } = mockClassify(() => ({ judgments: [] }), 1.0);
  const res = await runRecommendationLlmMatch(db, llm, {
    now: NOW,
    batchSize: 1,
    budgetUsd: 0.5,
  });
  assert.equal(res.candidates, 2);
  assert.equal(prompts.length, 1, 'second batch skipped once the budget is spent');
  assert.match(
    prompts[0],
    /purchase \[integration\.gmail\.message\] <untrusted-content nonce="[^"]+" source="integration\.gmail\.message">Your order has shipped![^<]*<\/untrusted-content-/,
    'third-party email text is fenced as untrusted',
  );
  assert.equal(res.judged, 1);
  for (const id of ids) assert.equal(getRecommendation(db, id)?.status, 'open');
  closeDb(db);
});
