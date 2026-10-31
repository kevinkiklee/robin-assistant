import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LLMDispatcher } from '../../llm/dispatcher.ts';
import type { InvokeRequest, LLMProvider } from '../../llm/types.ts';
import { closeDb, type RobinDb } from '../../memory/db.ts';
import { applySpecProposals, listOpenSpeclessPredictions, proposeSpecs } from './backfill.ts';
import { freshDb } from './test-helpers.ts';

function llmReturning(
  reply: (req: InvokeRequest) => unknown,
  calls: InvokeRequest[] = [],
): LLMDispatcher {
  const provider: LLMProvider = {
    name: 'fake',
    capabilities: new Set(['classify']),
    meta: { contextWindow: 4096, inputPricePerM: 0, outputPricePerM: 0 },
    invoke: async (req) => {
      calls.push(req);
      return {
        text: JSON.stringify(reply(req)),
        usage: { inputTokens: 0, outputTokens: 0 },
        costUsd: 0,
        latencyMs: 0,
        provider: 'fake',
      };
    },
  };
  const d = new LLMDispatcher();
  d.register('fake', provider);
  d.assign('classify', 'fake');
  return d;
}

function seed(db: RobinDb): { a: number; b: number; c: number; closed: number; specd: number } {
  const ins = db.prepare(
    `INSERT INTO predictions (claim, confidence, deadline, outcome, spec) VALUES (?, ?, ?, ?, ?)`,
  );
  const id = (claim: string, outcome: string | null = null, spec: string | null = null) =>
    Number(ins.run(claim, 0.5, '2026-10-14', outcome, spec).lastInsertRowid);
  return {
    a: id('Acme closes above $80 by 2027-03-01'),
    b: id('Sam books Harbortown lodging before 03/02'),
    c: id('weekly ride count reaches 4'),
    closed: id('old resolved one', 'right'),
    specd: id('already spec’d', null, '{"source":"whoop"}'),
  };
}

test('backfill: proposes for open spec-less rows only, validates, never writes on its own', async () => {
  const db = freshDb();
  const ids = seed(db);
  assert.deepEqual(
    listOpenSpeclessPredictions(db).map((p) => p.id),
    [ids.a, ids.b, ids.c],
  );
  const calls: InvokeRequest[] = [];
  const llm = llmReturning(
    () => ({
      specs: [
        {
          id: ids.a,
          spec: { source: 'finance', metric: 'balance', key: 'Acme', op: '>', threshold: 80 },
        },
        { id: ids.b, spec: null },
        // invalid: a windowed count without window_days
        {
          id: ids.c,
          spec: { source: 'whoop', metric: 'workouts', key: 'cycling', op: '>=', threshold: 4 },
        },
      ],
    }),
    calls,
  );
  const proposals = await proposeSpecs(db, llm);
  assert.equal(calls.length, 1, 'one batched classify call');
  assert.ok(calls[0].outputSchema, 'zod outputSchema passed');
  assert.match(calls[0].systemPrompt ?? '', /finance\.balance/);
  const by = new Map(proposals.map((p) => [p.id, p]));
  assert.equal(by.get(ids.a)?.spec?.key, 'Acme');
  assert.equal(by.get(ids.b)?.spec, null);
  assert.equal(by.get(ids.b)?.error, undefined);
  assert.match(by.get(ids.c)?.error ?? '', /window_days/);

  const before = db
    .prepare(`SELECT COUNT(*) AS c FROM predictions WHERE spec IS NOT NULL`)
    .get() as {
    c: number;
  };
  assert.equal(before.c, 1, 'proposeSpecs is read-only');

  assert.equal(applySpecProposals(db, proposals), 1);
  const stored = db.prepare(`SELECT spec FROM predictions WHERE id = ?`).get(ids.a) as {
    spec: string;
  };
  assert.equal(JSON.parse(stored.spec).metric, 'balance');
  closeDb(db);
});

test('backfill: batches by size; an LLM failure yields no proposals rather than throwing', async () => {
  const db = freshDb();
  seed(db);
  const calls: InvokeRequest[] = [];
  const llm = llmReturning(() => {
    throw new Error('provider down');
  }, calls);
  const proposals = await proposeSpecs(db, llm, { batchSize: 2 });
  assert.equal(calls.length, 2, '3 rows / batch 2 = 2 calls');
  assert.equal(proposals.length, 3);
  assert.ok(proposals.every((p) => p.spec === null));
  closeDb(db);
});
