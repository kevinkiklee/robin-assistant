import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { LLMDispatcher } from '../../llm/dispatcher.ts';
import type { InvokeResult, LLMProvider } from '../../llm/types.ts';
import { closeDb, openDb, type RobinDb } from '../../memory/db.ts';
import { ingest } from '../../memory/ingest.ts';
import { allMigrations, applyMigrations } from '../../memory/migrations/index.ts';
import { getScanCursor } from './cursor.ts';
import { runRecommendationScan } from './scan.ts';
import {
  getRecommendation,
  insertRecommendation,
  listOpenRecommendations,
  listRecommendations,
} from './store.ts';

function freshDb(): RobinDb {
  const dir = mkdtempSync(join(tmpdir(), 'robin-rec-scan-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

const NOW = new Date('2026-06-17T00:00:00Z');

/**
 * Insert a `session.captured` event with a real content row (the scan joins
 * events_content.body via content_ref). `ingest` always stamps `ts` with the current
 * time, so we UPDATE it afterward to control window membership; default is recent.
 */
function insertSession(
  db: RobinDb,
  opts: { body: string; ts?: string; category?: string } = { body: '' },
): number {
  const ts = opts.ts ?? '2026-06-14T12:00:00.000Z';
  const { eventId } = ingest(db, null, {
    kind: 'session.captured',
    source: 'capture',
    content: opts.body,
    payload: { category: opts.category ?? 'personal' },
  });
  db.prepare(`UPDATE events SET ts = ? WHERE id = ?`).run(ts, eventId);
  return eventId;
}

/**
 * A dispatcher whose `reasoning` role returns a FIXED structured scan object at a fixed
 * cost. Mirrors the tier-b test's mock (structured + costUsd injectable).
 */
function mockDispatcher(opts: { structured: unknown; costUsd?: number }): LLMDispatcher {
  const provider: LLMProvider = {
    name: 'mock',
    capabilities: new Set(['reasoning']),
    meta: { contextWindow: 200_000, inputPricePerM: 0, outputPricePerM: 0 },
    invoke: async (): Promise<InvokeResult> => ({
      text: '',
      structured: opts.structured,
      usage: { inputTokens: 0, outputTokens: 0 },
      costUsd: opts.costUsd ?? 0,
      latencyMs: 0,
      provider: 'mock',
    }),
  };
  const d = new LLMDispatcher();
  d.register('mock', provider);
  d.assign('reasoning', 'mock');
  return d;
}

const KETTLE_REC = {
  subject: 'Acme kettle',
  claim: 'Buy the Acme kettle for faster pour-over coffee.',
  verdict: 'buy',
  domain: 'finance',
  confidence: 0.8,
};

test('skip on no-LLM (null dispatcher)', async () => {
  const db = freshDb();
  insertSession(db, { body: '[USER]\nshould I buy a kettle?\n\n[ASSISTANT]\nyes, the kettle.' });
  const res = await runRecommendationScan(db, null, { now: NOW });
  assert.equal(res.skipped, true);
  assert.equal(res.recorded, 0);
  assert.equal(getScanCursor(db), 0, 'cursor not advanced on skip');
  closeDb(db);
});

test('skip when disabled', async () => {
  const db = freshDb();
  insertSession(db, { body: '[USER]\nq\n\n[ASSISTANT]\na long enough answer to pass the floor.' });
  const llm = mockDispatcher({ structured: { recommendations: [KETTLE_REC] } });
  const res = await runRecommendationScan(db, llm, { enabled: false, now: NOW });
  assert.equal(res.skipped, true);
  assert.equal(listRecommendations(db).length, 0, 'nothing recorded when disabled');
  closeDb(db);
});

test('skip on no recent sessions (no captured events at all)', async () => {
  const db = freshDb();
  const llm = mockDispatcher({ structured: { recommendations: [KETTLE_REC] } });
  const res = await runRecommendationScan(db, llm, { now: NOW });
  assert.equal(res.skipped, true);
  assert.equal(res.scanned, 0);
  closeDb(db);
});

test('extracts + records new open recommendations from a session', async () => {
  const db = freshDb();
  insertSession(db, {
    body: '[USER]\nshould I get a kettle?\n\n[ASSISTANT]\nBuy the Acme kettle — light, compact, and quick enough for pour-over coffee.',
  });
  const llm = mockDispatcher({ structured: { recommendations: [KETTLE_REC] } });

  const res = await runRecommendationScan(db, llm, { now: NOW });
  assert.equal(res.skipped, false);
  assert.equal(res.scanned, 1);
  assert.equal(res.recorded, 1);
  assert.equal(res.deduped, 0);

  const open = listOpenRecommendations(db);
  assert.equal(open.length, 1);
  assert.equal(open[0].subject, 'Acme kettle');
  assert.equal(open[0].verdict, 'buy');
  assert.equal(open[0].domain, 'finance');
  assert.equal(open[0].status, 'open');
  assert.equal(open[0].confidence, 0.8);
  assert.ok(open[0].sourceEventId, 'tagged with the source session event id');
  assert.ok(getScanCursor(db) > 0, 'cursor advanced past the scanned session');
  closeDb(db);
});

test('dedups an extracted rec that already exists in the ledger (not re-inserted)', async () => {
  const db = freshDb();
  // Pre-existing recommendation with the SAME subject (e.g. logged explicitly earlier).
  insertRecommendation(db, {
    subject: 'Acme kettle',
    claim: 'buy it',
    domain: 'finance',
  });
  insertSession(db, {
    body: '[USER]\nremind me about the kettle\n\n[ASSISTANT]\nYes — buy the Acme kettle.',
  });
  const llm = mockDispatcher({ structured: { recommendations: [KETTLE_REC] } });

  const res = await runRecommendationScan(db, llm, { now: NOW });
  assert.equal(res.recorded, 0, 'duplicate subject not re-inserted');
  assert.equal(res.deduped, 1);
  assert.equal(listRecommendations(db).length, 1, 'still just the one pre-existing rec');
  closeDb(db);
});

test('over-budget → discard, nothing recorded, cursor not advanced', async () => {
  const db = freshDb();
  insertSession(db, {
    body: '[USER]\nkettle?\n\n[ASSISTANT]\nBuy the Acme kettle for faster pour-over today.',
  });
  const llm = mockDispatcher({ costUsd: 99, structured: { recommendations: [KETTLE_REC] } });

  const res = await runRecommendationScan(db, llm, { now: NOW, budgetUsd: 1.0 });
  assert.equal(res.skipped, false);
  assert.equal(res.recorded, 0, 'no rec recorded when over budget');
  assert.equal(listRecommendations(db).length, 0);
  assert.equal(getScanCursor(db), 0, 'cursor not advanced — sessions re-scanned next run');
  closeDb(db);
});

test('domain validation falls back to preferences for an unknown domain', async () => {
  const db = freshDb();
  insertSession(db, {
    body: '[USER]\nwhat lunch bag?\n\n[ASSISTANT]\nTry the Acme Lunch Tote — best for your kitchen.',
  });
  const llm = mockDispatcher({
    structured: {
      recommendations: [
        {
          subject: 'Acme Lunch Tote 20L',
          claim: 'Try the Acme Lunch Tote for your kitchen.',
          verdict: 'try',
          domain: 'gadgets', // NOT a PERSONAL_DOMAIN → must fall back
          confidence: 0.6,
        },
      ],
    },
  });

  const res = await runRecommendationScan(db, llm, { now: NOW });
  assert.equal(res.recorded, 1);
  const open = listOpenRecommendations(db);
  assert.equal(open[0].domain, 'preferences', 'invalid domain fell back to preferences');
  assert.equal(open[0].verdict, 'try');
  closeDb(db);
});

test('invalid verdict falls back to other; cursor advances on empty extraction', async () => {
  const db = freshDb();
  insertSession(db, {
    body: '[USER]\nany restaurant?\n\n[ASSISTANT]\nGo to Corner Bistro — your kind of spot.',
  });
  const llm = mockDispatcher({
    structured: {
      recommendations: [
        {
          subject: 'Corner Bistro',
          claim: 'Go to Corner Bistro.',
          verdict: 'definitely', // not in the allowed set → other
          domain: 'preferences',
          confidence: 0.5,
        },
      ],
    },
  });
  const res = await runRecommendationScan(db, llm, { now: NOW });
  assert.equal(res.recorded, 1);
  assert.equal(listOpenRecommendations(db)[0].verdict, 'other', 'invalid verdict → other');
  closeDb(db);
});

test('confidence floor: a candidate under 0.5 is dropped, not recorded', async () => {
  const db = freshDb();
  insertSession(db, {
    body: '[USER]\nbig mixer?\n\n[ASSISTANT]\nMaybe the Acme 7-quart mixer, hard to say.',
  });
  const llm = mockDispatcher({
    structured: {
      recommendations: [
        {
          subject: 'Acme 7-quart mixer',
          claim: 'Maybe try the Acme 7-quart mixer.',
          verdict: 'try',
          domain: 'creative',
          confidence: 0.3, // under MIN_SCAN_CONFIDENCE → dropped
        },
      ],
    },
  });
  const res = await runRecommendationScan(db, llm, { now: NOW });
  assert.equal(res.dropped, 1);
  assert.equal(res.recorded, 0);
  assert.equal(res.deduped, 0);
  assert.equal(listRecommendations(db).length, 0, 'low-confidence candidate never inserted');
  closeDb(db);
});

test('gate dedup: a candidate duplicating an open rec is deduped, not inserted', async () => {
  const db = freshDb();
  // Same normalized subject + same verdict as the candidate, but NOT caught by the
  // legacy checks: lowercase-exact differs ('boggle!' vs 'boggle') and the
  // single-token subject is below subjectMatches' ≥2-token bar — only the gate's
  // normalized-equality key catches it.
  const { id } = insertRecommendation(db, {
    subject: 'Boggle!',
    claim: 'try it',
    verdict: 'try',
    domain: 'creative',
  });
  insertSession(db, {
    body: '[USER]\nword game?\n\n[ASSISTANT]\nTry Boggle for game night.',
  });
  const llm = mockDispatcher({
    structured: {
      recommendations: [
        {
          subject: 'boggle',
          claim: 'Try Boggle.',
          verdict: 'try',
          domain: 'creative',
          confidence: 0.8,
        },
      ],
    },
  });
  const res = await runRecommendationScan(db, llm, { now: NOW });
  assert.equal(res.recorded, 0, 'duplicate not re-inserted');
  assert.equal(res.deduped, 1);
  assert.equal(res.dropped, 0);
  assert.equal(listRecommendations(db).length, 1, 'still just the one pre-existing rec');
  assert.match(getRecommendation(db, id)?.evidence ?? '', /re-recommended/);
  closeDb(db);
});

test('out-of-window + dev sessions are skipped but the cursor still advances past them', async () => {
  const db = freshDb();
  // A dev session and an old (out-of-window) session — neither should be fed to the LLM,
  // but both are genuinely consumed so the cursor must move past them.
  insertSession(db, {
    body: '[USER]\nfix the build\n\n[ASSISTANT]\nrefactored the cron.',
    category: 'dev',
  });
  insertSession(db, {
    body: '[USER]\nold q\n\n[ASSISTANT]\nBuy the Acme kettle (this is stale, > window).',
    ts: '2026-05-01T12:00:00.000Z',
  });
  const lastId = insertSession(db, {
    body: '[USER]\nold dev too\n\n[ASSISTANT]\nmerged the PR and bumped the cursor.',
    category: 'dev',
  });
  const llm = mockDispatcher({ structured: { recommendations: [KETTLE_REC] } });

  const res = await runRecommendationScan(db, llm, { now: NOW, windowDays: 14 });
  assert.equal(res.skipped, true, 'no in-window personal sessions → skipped, no LLM call');
  assert.equal(res.recorded, 0);
  assert.equal(getScanCursor(db), lastId, 'cursor advanced past every consumed row');
  closeDb(db);
});

test('the LLM matching pass runs after extraction — even with no new sessions — and can be disabled', async () => {
  const db = freshDb();
  const { id } = insertRecommendation(db, {
    subject: 'Acme Bread Box',
    claim: 'Buy the bread box.',
    verdict: 'buy',
    domain: 'home',
  });
  db.prepare(`UPDATE recommendations SET created_at = ? WHERE id = ?`).run(
    '2026-06-01 00:00:00',
    id,
  );
  const sessionId = insertSession(db, {
    body: '[USER]\nI ordered the acme bread box',
    ts: '2026-06-10T12:00:00.000Z',
  });
  const provider: LLMProvider = {
    name: 'mock',
    capabilities: new Set(['reasoning', 'classify']),
    meta: { contextWindow: 200_000, inputPricePerM: 0, outputPricePerM: 0 },
    invoke: async (req): Promise<InvokeResult> => ({
      text: '',
      structured: req.systemPrompt?.includes('followed up')
        ? {
            judgments: [
              {
                rec: id,
                outcome: 'did_it',
                confidence: 0.9,
                evidence: 'ordered',
                eventId: sessionId,
              },
            ],
          }
        : { recommendations: [] },
      usage: { inputTokens: 0, outputTokens: 0 },
      costUsd: 0,
      latencyMs: 0,
      provider: 'mock',
    }),
  };
  const llm = new LLMDispatcher();
  llm.register('mock', provider);
  llm.assign('reasoning', 'mock');
  llm.assign('classify', 'mock');

  const off = await runRecommendationScan(db, llm, { now: NOW, match: false });
  assert.equal(off.match, undefined);
  assert.equal(getRecommendation(db, id)?.status, 'open');

  // Second run: extraction has no new sessions (cursor advanced), match still runs.
  const res = await runRecommendationScan(db, llm, { now: NOW });
  assert.equal(res.scanned, 0);
  assert.equal(res.match?.acted, 1);
  assert.equal(getRecommendation(db, id)?.status, 'acted');
  closeDb(db);
});
