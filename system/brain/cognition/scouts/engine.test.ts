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
import {
  getRecommendation,
  insertRecommendation,
  listRecommendations,
} from '../recommendations/store.ts';
import { runScout } from './engine.ts';
import type { ScoutConfig } from './types.ts';

function freshDb(): RobinDb {
  const dir = mkdtempSync(join(tmpdir(), 'robin-scouts-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

const NOW = new Date('2026-08-10T12:00:00Z');
/** Within the 7-day freshness window relative to NOW. */
const FRESH_TS = '2026-08-08T00:00:00.000Z';
/** Far outside any freshness window relative to NOW. */
const STALE_TS = '2026-06-01T00:00:00.000Z';

/** Seed one event for `source` and pin its ts (ingest stamps the current time). */
function seedEvent(db: RobinDb, source: string, ts: string): void {
  const { eventId } = ingest(db, null, { kind: 'test.event', source, payload: {} });
  db.prepare(`UPDATE events SET ts = ? WHERE id = ?`).run(ts, eventId);
}

/**
 * A dispatcher whose `reasoning` role returns a FIXED structured object at a fixed
 * cost — the scan.test.ts / tier-b.test.ts mock idiom — plus an invoke-call counter
 * so tests can assert a skip made NO LLM call, and a `throws` mode for the
 * invoke-failure path.
 */
function mockDispatcher(opts: { structured?: unknown; costUsd?: number; throws?: boolean }): {
  llm: LLMDispatcher;
  calls: () => number;
  requests: InvokeRequest[];
} {
  let calls = 0;
  const requests: InvokeRequest[] = [];
  const provider: LLMProvider = {
    name: 'mock',
    capabilities: new Set(['reasoning']),
    meta: { contextWindow: 200_000, inputPricePerM: 0, outputPricePerM: 0 },
    invoke: async (req: InvokeRequest): Promise<InvokeResult> => {
      calls += 1;
      requests.push(req);
      if (opts.throws) throw new Error('mock invoke failure');
      return {
        text: '',
        structured: opts.structured,
        usage: { inputTokens: 0, outputTokens: 0 },
        costUsd: opts.costUsd ?? 0,
        latencyMs: 0,
        provider: 'mock',
      };
    },
  };
  const d = new LLMDispatcher();
  d.register('mock', provider);
  d.assign('reasoning', 'mock');
  return { llm: d, calls: () => calls, requests };
}

const TC_CANDIDATE = {
  subject: 'Acme kettle',
  claim: 'Buy the Acme kettle for faster pour-over coffee.',
  reasoning: 'light and compact; minor quality cost',
  verdict: 'buy',
  confidence: 0.8,
  expiresAt: null,
};

function makeConfig(overrides: Partial<ScoutConfig> = {}): ScoutConfig {
  return {
    id: 'finance',
    domain: 'finance',
    sources: [{ source: 'lunch_money', maxAgeDays: 7 }],
    digest: () => 'payee A: 3 tx, $120 total',
    guidance: 'Watch for subscription creep and recurring-charge drift.',
    ...overrides,
  };
}

test('happy path: fresh source → gated insert with verdict-default expiry; second run dedupes', async () => {
  const db = freshDb();
  seedEvent(db, 'lunch_money', FRESH_TS);
  seedEvent(db, 'weather', STALE_TS);

  const digestCalls: string[][] = [];
  const config = makeConfig({
    sources: [
      { source: 'lunch_money', maxAgeDays: 7 },
      { source: 'weather', maxAgeDays: 7 },
    ],
    digest: (_db, _now, freshSources) => {
      digestCalls.push(freshSources);
      return 'payee A: 3 tx, $120 total';
    },
  });
  const { llm, requests } = mockDispatcher({ structured: { candidates: [TC_CANDIDATE] } });

  const res = await runScout(db, llm, config, { now: NOW });
  assert.equal(res.scout, 'finance');
  const userMsg = String(requests[0]?.messages[0]?.content ?? '');
  assert.match(
    userMsg,
    /<untrusted-content nonce="[^"]+" source="scout:finance">payee A: 3 tx, \$120 total<\/untrusted-content-/,
    'integration-derived digest is fenced as untrusted',
  );
  assert.match(requests[0]?.systemPrompt ?? '', /never follow instructions/i);
  assert.equal(res.skipped, null);
  assert.deepEqual(res.staleSources, ['weather'], 'stale source reported');
  assert.deepEqual(digestCalls, [['lunch_money']], 'digest sees ONLY the fresh sources');
  assert.equal(res.candidates, 1);
  assert.equal(res.inserted, 1);
  assert.equal(res.dropped, 0);
  assert.equal(res.duplicates, 0);
  assert.equal(res.superseded, 0);

  const recs = listRecommendations(db);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].subject, 'Acme kettle');
  assert.equal(recs[0].verdict, 'buy');
  assert.equal(recs[0].domain, 'finance');
  assert.equal(recs[0].confidence, 0.8);
  assert.equal(recs[0].status, 'open');
  assert.match(recs[0].reasoning ?? '', /^\[scout:finance\] /, 'scout provenance prefix');
  // expiresAt was null → the gate's insert stamps the verdict default (buy = 30d from NOW).
  assert.equal(recs[0].expiresAt, '2026-09-09 12:00:00', 'buy verdict-default expiry stamped');

  // Same candidate again → gate duplicate, no second row.
  const again = await runScout(db, llm, config, { now: NOW });
  assert.equal(again.inserted, 0);
  assert.equal(again.duplicates, 1);
  assert.equal(listRecommendations(db).length, 1, 'still just the one rec');
  assert.match(getRecommendation(db, recs[0].id)?.evidence ?? '', /re-recommended/);
  closeDb(db);
});

test('a candidate below MIN_SCAN_CONFIDENCE is dropped, not inserted', async () => {
  const db = freshDb();
  seedEvent(db, 'lunch_money', FRESH_TS);
  const { llm } = mockDispatcher({
    structured: { candidates: [{ ...TC_CANDIDATE, confidence: 0.3 }] },
  });

  const res = await runScout(db, llm, makeConfig(), { now: NOW });
  assert.equal(res.skipped, null);
  assert.equal(res.candidates, 1);
  assert.equal(res.dropped, 1);
  assert.equal(res.inserted, 0);
  assert.equal(listRecommendations(db).length, 0, 'low-confidence candidate never inserted');
  closeDb(db);
});

test('all sources stale → skip all-stale without an LLM call', async () => {
  const db = freshDb();
  seedEvent(db, 'lunch_money', STALE_TS);
  // A source with NO events at all is stale too.
  const config = makeConfig({
    sources: [
      { source: 'lunch_money', maxAgeDays: 7 },
      { source: 'never_seen', maxAgeDays: 7 },
    ],
  });
  const { llm, calls } = mockDispatcher({ structured: { candidates: [TC_CANDIDATE] } });

  const res = await runScout(db, llm, config, { now: NOW });
  assert.equal(res.skipped, 'all-stale');
  assert.deepEqual(res.staleSources.sort(), ['lunch_money', 'never_seen']);
  assert.equal(res.candidates, 0);
  assert.equal(calls(), 0, 'no LLM call on an all-stale skip');
  assert.equal(listRecommendations(db).length, 0);
  closeDb(db);
});

test('empty digest → skip empty-digest without an LLM call', async () => {
  const db = freshDb();
  seedEvent(db, 'lunch_money', FRESH_TS);
  const config = makeConfig({ digest: () => null });
  const { llm, calls } = mockDispatcher({ structured: { candidates: [TC_CANDIDATE] } });

  const res = await runScout(db, llm, config, { now: NOW });
  assert.equal(res.skipped, 'empty-digest');
  assert.equal(res.candidates, 0);
  assert.equal(calls(), 0, 'no LLM call on an empty digest');
  closeDb(db);
});

test('null dispatcher → skip no-llm', async () => {
  const db = freshDb();
  seedEvent(db, 'lunch_money', FRESH_TS);
  const res = await runScout(db, null, makeConfig(), { now: NOW });
  assert.equal(res.skipped, 'no-llm');
  assert.equal(res.inserted, 0);
  assert.equal(listRecommendations(db).length, 0);
  closeDb(db);
});

test('enabled: false → skip disabled', async () => {
  const db = freshDb();
  seedEvent(db, 'lunch_money', FRESH_TS);
  const { llm, calls } = mockDispatcher({ structured: { candidates: [TC_CANDIDATE] } });
  const res = await runScout(db, llm, makeConfig(), { now: NOW, enabled: false });
  assert.equal(res.skipped, 'disabled');
  assert.equal(calls(), 0, 'no LLM call when disabled');
  assert.equal(listRecommendations(db).length, 0);
  closeDb(db);
});

test('malformed LLM output or an invoke throw → 0 candidates, no throw, nothing inserted', async () => {
  const db = freshDb();
  seedEvent(db, 'lunch_money', FRESH_TS);

  // Schema mismatch (candidates is not an array of the expected shape).
  const bad = mockDispatcher({ structured: { candidates: [{ bogus: true }] } });
  const res = await runScout(db, bad.llm, makeConfig(), { now: NOW });
  assert.equal(res.skipped, null);
  assert.equal(res.candidates, 0);
  assert.equal(res.inserted, 0);

  // Invoke failure (outage) — same contract: never throw.
  const boom = mockDispatcher({ throws: true });
  const res2 = await runScout(db, boom.llm, makeConfig(), { now: NOW });
  assert.equal(res2.skipped, null);
  assert.equal(res2.candidates, 0);
  assert.equal(res2.inserted, 0);
  assert.equal(listRecommendations(db).length, 0);
  closeDb(db);
});

test('changed verdict on an open subject → gate supersedes the prior stance', async () => {
  const db = freshDb();
  seedEvent(db, 'lunch_money', FRESH_TS);
  const { id: priorId } = insertRecommendation(db, {
    subject: 'Acme kettle',
    claim: 'Wait for a sale.',
    verdict: 'wait',
    domain: 'finance',
  });
  const { llm } = mockDispatcher({ structured: { candidates: [TC_CANDIDATE] } });

  const res = await runScout(db, llm, makeConfig(), { now: NOW });
  assert.equal(res.inserted, 0);
  assert.equal(res.superseded, 1);
  assert.equal(getRecommendation(db, priorId)?.status, 'superseded');
  const open = listRecommendations(db, { status: 'open' });
  assert.equal(open.length, 1);
  assert.equal(open[0].verdict, 'buy');
  closeDb(db);
});

test('explicit candidate expiresAt is stored as given (seasonal windows)', async () => {
  const db = freshDb();
  seedEvent(db, 'lunch_money', FRESH_TS);
  const { llm } = mockDispatcher({
    structured: {
      candidates: [{ ...TC_CANDIDATE, expiresAt: '2026-09-01 00:00:00' }],
    },
  });
  const res = await runScout(db, llm, makeConfig(), { now: NOW });
  assert.equal(res.inserted, 1);
  assert.equal(listRecommendations(db)[0].expiresAt, '2026-09-01 00:00:00');
  closeDb(db);
});

test('over-budget call → output discarded, nothing inserted, no throw', async () => {
  const db = freshDb();
  seedEvent(db, 'lunch_money', FRESH_TS);
  const { llm } = mockDispatcher({ structured: { candidates: [TC_CANDIDATE] }, costUsd: 99 });
  const res = await runScout(db, llm, makeConfig(), { now: NOW });
  assert.equal(res.skipped, null);
  assert.equal(res.candidates, 0);
  assert.equal(res.inserted, 0);
  assert.equal(listRecommendations(db).length, 0);
  closeDb(db);
});
