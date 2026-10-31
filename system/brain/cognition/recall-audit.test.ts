import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { LLMDispatcher } from '../llm/dispatcher.ts';
import type { InvokeResult, LLMProvider } from '../llm/types.ts';
import { closeDb, openDb, type RobinDb } from '../memory/db.ts';
import { ingest } from '../memory/ingest.ts';
import { allMigrations, applyMigrations } from '../memory/migrations/index.ts';
import { COGNITION_JOBS, registerCognitionJobs } from './jobs.ts';
import { computeInjectionStats, runRecallAudit } from './recall-audit.ts';

function freshDb(): RobinDb {
  const dir = mkdtempSync(join(tmpdir(), 'robin-recall-audit-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

/** Fixed "now" for deterministic 35-day windows and metrics day stamps. */
const NOW = new Date('2026-08-01T12:00:00.000Z');
const DAY = 86_400_000;

function iso(msBeforeNow: number): string {
  return new Date(NOW.getTime() - msBeforeNow).toISOString();
}

/**
 * Dispatcher whose `classify` role replays a FIXED response queue (one entry per
 * judge call, last entry repeated). Mirrors the scan test's mock; the audit judges
 * rows newest-first, so queue order = recall_log ts DESC order.
 */
function mockClassify(responses: string[]): LLMDispatcher {
  let i = 0;
  const provider: LLMProvider = {
    name: 'mock',
    capabilities: new Set(['classify']),
    meta: { contextWindow: 200_000, inputPricePerM: 0, outputPricePerM: 0 },
    invoke: async (): Promise<InvokeResult> => {
      const text = responses[Math.min(i, responses.length - 1)] ?? '';
      i++;
      return {
        text,
        usage: { inputTokens: 0, outputTokens: 0 },
        costUsd: 0,
        latencyMs: 0,
        provider: 'mock',
      };
    },
  };
  const d = new LLMDispatcher();
  d.register('mock', provider);
  d.assign('classify', 'mock');
  return d;
}

function insertContent(db: RobinDb, body: string): number {
  const info = db
    .prepare(`INSERT INTO events_content (ts, body) VALUES (?, ?)`)
    .run(NOW.toISOString(), body);
  return Number(info.lastInsertRowid);
}

/** Same query_hash idiom as recall.ts — base64 of the query, truncated to 64 chars. */
function queryHash(query: string): string {
  return Buffer.from(query).toString('base64').slice(0, 64);
}

function insertRecallLog(
  db: RobinDb,
  opts: {
    ts: string;
    query?: string;
    sessionId?: string | null;
    snippets: number[];
    source?: string;
    keptJson?: string | null;
  },
): number {
  const kept =
    opts.keptJson !== undefined
      ? opts.keptJson
      : JSON.stringify({ docs: [], snippets: opts.snippets, habits: 0, loops: 0 });
  const info = db
    .prepare(
      `INSERT INTO recall_log
       (ts, query_hash, result_count, source, outcome, session_id, injected_content_ids, kept_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.ts,
      queryHash(opts.query ?? 'what umbrella should I bring?'),
      opts.snippets.length,
      opts.source ?? 'auto',
      'answered',
      opts.sessionId ?? null,
      JSON.stringify(opts.snippets),
      kept,
    );
  return Number(info.lastInsertRowid);
}

/** Captured session with the capture.ts body shape ([USER]/[ASSISTANT] marker blocks). */
function insertSession(db: RobinDb, opts: { sessionId: string; body: string; ts: string }): number {
  const { eventId } = ingest(db, null, {
    kind: 'session.captured',
    source: 'capture',
    content: opts.body,
    payload: { sessionId: opts.sessionId },
  });
  db.prepare(`UPDATE events SET ts = ? WHERE id = ?`).run(opts.ts, eventId);
  return eventId;
}

function metric(db: RobinDb, name: string): { day: string; value: number; n: number } | undefined {
  return db
    .prepare(`SELECT day, value, n FROM metrics_daily WHERE metric = ? ORDER BY day DESC LIMIT 1`)
    .get(name) as { day: string; value: number; n: number } | undefined;
}

test('recall-audit: happy path writes recall_precision + recall_utilization from sampled rows', async () => {
  const db = freshDb();
  const c1 = insertContent(db, 'Sam rides an Acme X1 bike on weekends.');
  const c2 = insertContent(db, 'Umbrella pick: Acme compact umbrella, storm model.');
  const c3 = insertContent(db, 'Lakeport library opening hours.');

  // Row A (newest, 1 day ago): 2 kept snippets + a captured answer AFTER the recall ts.
  insertRecallLog(db, { ts: iso(1 * DAY), sessionId: 'sess-a', snippets: [c1, c2] });
  insertSession(db, {
    sessionId: 'sess-a',
    ts: iso(1 * DAY - 60_000),
    body: '[USER]\nwhat umbrella should I bring?\n\n[ASSISTANT]\nBring the Acme compact umbrella, storm model — it fits the X1 bike basket.',
  });
  // Row B (2 days ago): 1 kept snippet + an answer.
  insertRecallLog(db, { ts: iso(2 * DAY), sessionId: 'sess-b', snippets: [c3] });
  insertSession(db, {
    sessionId: 'sess-b',
    ts: iso(2 * DAY - 60_000),
    body: '[USER]\nplan tomorrow\n\n[ASSISTANT]\nUnrelated answer about calendars.',
  });
  // Row C: outside the 35-day window — must NOT be sampled (would desync the queue).
  insertRecallLog(db, { ts: iso(60 * DAY), sessionId: 'sess-a', snippets: [c1] });

  const llm = mockClassify([
    '{"relevantCount": 2, "influenced": true}', // row A (newest first)
    '{"relevantCount": 0, "influenced": false}', // row B
  ]);
  const res = await runRecallAudit(db, llm, { now: NOW });

  assert.equal(res.skipped, false);
  assert.equal(res.sampled, 2, 'the 60-day-old row is outside the 35-day window');
  assert.equal(res.judgedItems, 3);
  assert.ok(res.precision !== null && Math.abs(res.precision - 2 / 3) < 1e-9);
  assert.equal(res.utilization, 0.5);

  const precision = metric(db, 'recall_precision');
  assert.ok(precision, 'recall_precision written');
  assert.equal(precision.day, '2026-08-01');
  assert.ok(Math.abs(precision.value - 2 / 3) < 1e-9);
  assert.equal(precision.n, 2, 'n = judged rows');

  const utilization = metric(db, 'recall_utilization');
  assert.ok(utilization, 'recall_utilization written');
  assert.equal(utilization.value, 0.5);
  assert.equal(utilization.n, 2, 'n = judged rows');
  closeDb(db);
});

test('recall-audit: missing-answer rows contribute to precision only (utilization unwritten)', async () => {
  const db = freshDb();
  const c1 = insertContent(db, 'Sam keeps a water bottle in the bag.');
  // Session id present but NO captured session event exists for it.
  insertRecallLog(db, { ts: iso(1 * DAY), sessionId: 'sess-gone', snippets: [c1] });

  // influenced:true must be IGNORED — no answer existed to influence.
  const llm = mockClassify(['{"relevantCount": 1, "influenced": true}']);
  const res = await runRecallAudit(db, llm, { now: NOW });

  assert.equal(res.sampled, 1);
  assert.equal(res.judgedItems, 1);
  assert.equal(res.precision, 1);
  assert.equal(res.utilization, null, 'no answered rows → utilization is null');
  assert.ok(metric(db, 'recall_precision'), 'precision still written');
  assert.equal(metric(db, 'recall_utilization'), undefined, 'null metric skips the write');
  closeDb(db);
});

test('recall-audit: malformed judge JSON skips the row, later rows still judged', async () => {
  const db = freshDb();
  const c1 = insertContent(db, 'Excerpt one.');
  const c2 = insertContent(db, 'Excerpt two.');
  insertRecallLog(db, { ts: iso(1 * DAY), sessionId: 'sess-bad', snippets: [c1, c2] });
  insertRecallLog(db, { ts: iso(2 * DAY), sessionId: 'sess-ok', snippets: [c1] });
  insertSession(db, {
    sessionId: 'sess-ok',
    ts: iso(2 * DAY - 60_000),
    body: '[USER]\nq\n\n[ASSISTANT]\nAnswer shaped by excerpt one.',
  });

  const llm = mockClassify([
    'I think both excerpts were quite relevant.', // malformed → row skipped
    '{"relevantCount": 1, "influenced": true}',
  ]);
  const res = await runRecallAudit(db, llm, { now: NOW });

  assert.equal(res.sampled, 2);
  assert.equal(res.judgedItems, 1, 'malformed row contributes no judged items');
  assert.equal(res.precision, 1);
  assert.equal(res.utilization, 1);
  assert.equal(metric(db, 'recall_precision')?.n, 1, 'n counts only judged rows');
  closeDb(db);
});

test('recall-audit: every row malformed → null metrics, nothing written', async () => {
  const db = freshDb();
  const c1 = insertContent(db, 'Excerpt.');
  insertRecallLog(db, { ts: iso(1 * DAY), sessionId: null, snippets: [c1] });

  const res = await runRecallAudit(db, mockClassify(['not json at all']), { now: NOW });
  assert.equal(res.sampled, 1);
  assert.equal(res.judgedItems, 0);
  assert.equal(res.precision, null);
  assert.equal(res.utilization, null);
  assert.equal(metric(db, 'recall_precision'), undefined);
  assert.equal(metric(db, 'recall_utilization'), undefined);
  closeDb(db);
});

test('recall-audit: llm === null → skipped no-op, no writes', async () => {
  const db = freshDb();
  const c1 = insertContent(db, 'Excerpt.');
  insertRecallLog(db, { ts: iso(1 * DAY), sessionId: null, snippets: [c1] });

  const res = await runRecallAudit(db, null, { now: NOW });
  assert.equal(res.skipped, true);
  assert.equal(res.sampled, 0);
  assert.equal(res.precision, null);
  assert.equal(res.utilization, null);
  assert.equal(metric(db, 'recall_precision'), undefined);
  closeDb(db);
});

test('recall-audit: empty sample writes nothing (manual + kept_json-less rows excluded)', async () => {
  const db = freshDb();
  const c1 = insertContent(db, 'Excerpt.');
  // Wrong source and missing kept_json — neither is sampled.
  insertRecallLog(db, { ts: iso(1 * DAY), sessionId: null, snippets: [c1], source: 'manual' });
  insertRecallLog(db, { ts: iso(1 * DAY), sessionId: null, snippets: [c1], keptJson: null });

  const res = await runRecallAudit(db, mockClassify(['{"relevantCount":1,"influenced":true}']), {
    now: NOW,
  });
  assert.equal(res.sampled, 0);
  assert.equal(res.skipped, false);
  assert.equal(res.judgedItems, 0);
  assert.equal(res.precision, null);
  assert.equal(metric(db, 'recall_precision'), undefined);
  closeDb(db);
});

test('recall-audit: sampleSize caps the sample, newest rows first', async () => {
  const db = freshDb();
  const c1 = insertContent(db, 'Excerpt.');
  insertRecallLog(db, { ts: iso(1 * DAY), sessionId: null, snippets: [c1] });
  insertRecallLog(db, { ts: iso(2 * DAY), sessionId: null, snippets: [c1] });
  insertRecallLog(db, { ts: iso(3 * DAY), sessionId: null, snippets: [c1] });

  const res = await runRecallAudit(db, mockClassify(['{"relevantCount":0,"influenced":false}']), {
    now: NOW,
    sampleSize: 2,
  });
  assert.equal(res.sampled, 2);
  assert.equal(res.judgedItems, 2);
  closeDb(db);
});

test('recall-audit: cron entry + handler are both wired in cognition jobs', () => {
  const job = COGNITION_JOBS.find((j) => j.name === 'recall-audit.run');
  assert.ok(job, 'recall-audit.run listed in COGNITION_JOBS');
  // 5:00am on the 1st — clear of the 3:40–4:30 nightly stack.
  assert.equal(job.cron, '0 5 1 * *');

  const db = freshDb();
  const handlers: string[] = [];
  const fakeDaemon = {
    registerHandler: (name: string) => {
      handlers.push(name);
    },
  } as unknown as Parameters<typeof registerCognitionJobs>[0];
  registerCognitionJobs(fakeDaemon, db, () => null);
  assert.ok(handlers.includes('recall-audit.run'), 'handler dispatch registered');
  const rows = db
    .prepare(`SELECT name FROM jobs WHERE state='pending' AND name='recall-audit.run'`)
    .all();
  assert.equal(rows.length, 1, 'cron row seeded');
  closeDb(db);
});

// ── Injection rate: derived from the kept set, not recall()'s 'answered' (2026-10-03) ──

test('computeInjectionStats: injected = non-empty kept set or outcome=injected; NULL kept = nothing injected', () => {
  const db = freshDb();
  const ts = iso(DAY);
  insertRecallLog(db, { ts, snippets: [1] }); // injected (snippet)
  insertRecallLog(db, {
    ts,
    snippets: [],
    keptJson: JSON.stringify({ docs: [], snippets: [], corrections: [7], habits: 0, loops: 0 }),
  }); // injected (correction only)
  insertRecallLog(db, {
    ts,
    snippets: [],
    keptJson: JSON.stringify({ docs: [], snippets: [], habits: 0, loops: 0 }),
  }); // filtered: pool non-empty, nothing kept
  insertRecallLog(db, { ts, snippets: [], keptJson: null }); // legacy empty turn ('answered')
  insertRecallLog(db, { ts, snippets: [5], source: 'manual' }); // not auto — excluded
  insertRecallLog(db, { ts: iso(40 * DAY), snippets: [1] }); // outside the window

  const s = computeInjectionStats(db, iso(35 * DAY));
  assert.deepEqual(s, { total: 4, injected: 2, rate: 0.5 });
  closeDb(db);
});

test('runRecallAudit: writes recall_injection_rate even with no LLM (deterministic)', async () => {
  const db = freshDb();
  insertRecallLog(db, { ts: iso(DAY), snippets: [1] });
  insertRecallLog(db, { ts: iso(DAY), snippets: [], keptJson: null });
  const r = await runRecallAudit(db, null, { now: NOW });
  assert.equal(r.skipped, true);
  assert.equal(r.injectionRate, 0.5);
  assert.equal(r.autoTurns, 2);
  const m = db
    .prepare(`SELECT value, n FROM metrics_daily WHERE metric = 'recall_injection_rate'`)
    .get() as { value: number; n: number };
  assert.deepEqual(m, { value: 0.5, n: 2 });
  closeDb(db);
});

test('runRecallAudit: empty-kept rows are never sampled for judging', async () => {
  const db = freshDb();
  const c = insertContent(db, 'Umbrella: Acme compact');
  // Newer empty-kept rows would otherwise crowd the 1-row sample.
  insertRecallLog(db, { ts: iso(DAY * 2), snippets: [c] });
  for (let i = 0; i < 3; i++) {
    insertRecallLog(db, {
      ts: iso(DAY - i),
      snippets: [],
      keptJson: JSON.stringify({ docs: [], snippets: [], corrections: [], habits: 0, loops: 0 }),
    });
  }
  const r = await runRecallAudit(db, mockClassify(['{"relevantCount":1,"influenced":false}']), {
    now: NOW,
    sampleSize: 1,
  });
  assert.equal(r.sampled, 1);
  assert.equal(r.judgedItems, 1);
  closeDb(db);
});
