import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SubscriptionLimitError } from '../llm/claude-agent.ts';
import { LLMDispatcher } from '../llm/dispatcher.ts';
import type { LLMProvider } from '../llm/types.ts';
import { insertBeliefCandidate, listBeliefCandidates } from '../memory/belief-candidate.ts';
import { closeDb, openDb } from '../memory/db.ts';
import { upsertEntity } from '../memory/entity.ts';
import { ingest } from '../memory/ingest.ts';
import { allMigrations, applyMigrations } from '../memory/migrations/index.ts';
import { classifyProvenance } from '../memory/provenance.ts';
import {
  chunkBody,
  claimsSchema,
  extractClaims,
  extractionSchema,
  isLowQualityEntity,
  isLowQualityPredicate,
  linkRelatedSessions,
  preprocessForExtraction,
  retryClaimFailures,
  runBiographer,
  type SessionSummary,
  stripHarnessScaffolding,
} from './biographer.ts';
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
        { type: 'person', name: 'Kevin', domain: 'identity' },
        { type: 'place', name: 'Lisbon', domain: 'travel' },
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
  const r = await runBiographer(db, llm, 10, { minSessionBodyChars: 0 });
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
      JSON.stringify({
        entities: [{ type: 'person', name: 'Sarah', domain: 'relationships' }],
        relations: [],
      }) +
      '\n```',
  );
  await captureSession(db, null, {
    sessionId: 's1',
    turns: [
      { role: 'user', content: 'tell me about Sarah' },
      { role: 'assistant', content: 'Sarah is a friend.' },
    ],
  });
  const r = await runBiographer(db, llm, 10, { minSessionBodyChars: 0 });
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
  const longContent = 'x'.repeat(8000);
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
        { type: 'person', name: 'Kevin', domain: 'identity' },
        { type: 'place', name: 'Lisbon', domain: 'travel' },
      ],
      relations: [{ subject: 'Kevin', predicate: 'visited', object: 'Lisbon' }],
    }),
    JSON.stringify({
      entities: [
        { type: 'person', name: 'kevin', domain: 'identity' }, // case-different duplicate
        { type: 'place', name: 'Porto', domain: 'travel' },
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

  const r = await runBiographer(db, dispatchLLM, 10, { batchChunks: 1 });
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

// Multi-tick processing — a session whose chunk count exceeds maxChunksPerTick
// must be processed across multiple runBiographer calls, advancing a persisted
// cursor each tick, with the `biographer.extracted` marker written only once the
// final chunk is done. This is what stops a large session from monopolizing a
// single tick past the daemon's 30-min sustained-CRITICAL gate (the restart loop).
test('biographer: processes a large session across multiple ticks (multi-tick)', async () => {
  const db = freshDb();

  // Body that chunks into several pieces at CHUNK_CHARS=20000: 6 turns, each ~22K
  // chars, so it produces multiple chunks.
  const turn = (role: string, content: string) => `[${role}]\n${content}`;
  const seg = 'word '.repeat(4400); // ~22000 chars
  const body = Array.from({ length: 6 }, (_, i) =>
    turn(i % 2 === 0 ? 'USER' : 'ASSISTANT', `segment ${i} ${seg}`),
  ).join('\n\n');
  const chunks = chunkBody(body, 20000);
  assert.ok(chunks.length >= 4, `need a multi-chunk body for this test, got ${chunks.length}`);

  // Count extraction LLM calls so we can assert each chunk is processed exactly once.
  let extractionCalls = 0;
  const d = mockLLM('{}');
  d.invoke = async () => {
    extractionCalls++;
    return {
      text: JSON.stringify({
        entities: [{ type: 'topic', name: `Entity${extractionCalls}`, domain: 'preferences' }],
        relations: [],
      }),
      usage: { inputTokens: 0, outputTokens: 0 },
      costUsd: 0,
      latencyMs: 0,
      provider: 'mock',
    };
  };

  const nowIso = new Date().toISOString();
  const contentInfo = db
    .prepare(`INSERT INTO events_content (ts, body) VALUES (?, ?)`)
    .run(nowIso, body);
  db.prepare(
    `INSERT INTO events (ts, kind, source, status, payload, content_ref) VALUES (?, 'session.captured', 'capture', 'ok', '{}', ?)`,
  ).run(nowIso, Number(contentInfo.lastInsertRowid));

  // First tick: bounded to 2 chunks → does NOT complete the session.
  const r1 = await runBiographer(db, d, 1, { maxChunksPerTick: 2 });
  assert.equal(r1.processed, 0, 'session should not be marked processed after a partial tick');
  assert.equal(extractionCalls, 2, 'first tick should process exactly maxChunksPerTick chunks');
  const markersAfter1 = db
    .prepare(`SELECT COUNT(*) AS c FROM events WHERE kind = 'biographer.extracted'`)
    .get() as { c: number };
  assert.equal(markersAfter1.c, 0, 'no extraction marker should be written mid-session');
  const progAfter1 = db.prepare(`SELECT next_chunk, total_chunks FROM biographer_progress`).get() as
    | { next_chunk: number; total_chunks: number }
    | undefined;
  assert.ok(progAfter1, 'a progress row should exist after a partial tick');
  assert.equal(progAfter1?.next_chunk, 2, 'cursor should advance to 2');
  assert.equal(progAfter1?.total_chunks, chunks.length);

  // Keep ticking until the session completes.
  let guard = 0;
  let completedTick = false;
  while (guard++ < 20) {
    const r = await runBiographer(db, d, 1, { maxChunksPerTick: 2 });
    if (r.processed > 0) {
      completedTick = true;
      break;
    }
  }
  assert.ok(completedTick, 'session should complete within a bounded number of ticks');

  // Every chunk extracted exactly once across all ticks, plus one session finalization call.
  assert.equal(extractionCalls, chunks.length + 1, 'chunks + 1 finalization call');

  // Exactly one marker, and the progress row cleaned up.
  const markers = db
    .prepare(`SELECT COUNT(*) AS c FROM events WHERE kind = 'biographer.extracted'`)
    .get() as { c: number };
  assert.equal(markers.c, 1, 'exactly one extraction marker after completion');
  const progRows = db.prepare(`SELECT COUNT(*) AS c FROM biographer_progress`).get() as {
    c: number;
  };
  assert.equal(progRows.c, 0, 'progress row should be deleted after completion');

  // Entities merged across all chunks should be persisted.
  const entCount = db.prepare(`SELECT COUNT(*) AS c FROM entities`).get() as { c: number };
  assert.equal(entCount.c, chunks.length, 'one entity per chunk should be persisted');

  closeDb(db);
});

// Bug G regression — a session whose body exceeds the (now generous) sanity
// ceiling is skipped with a `biographer.extracted` marker so it stops being
// re-selected. The threshold is injectable so this stays fast: a tiny body over
// a tiny injected ceiling exercises the same guardrail without a megabyte string.
test('biographer: skips oversized sessions and writes a skip marker (Bug G)', async () => {
  const db = freshDb();

  await captureSession(db, null, {
    sessionId: 'big-session',
    turns: [
      { role: 'user', content: 'tell me about the big session' },
      { role: 'assistant', content: 'lorem ipsum '.repeat(20) }, // ~240 chars, over the injected 100
    ],
  });

  // No LLM — if the guardrail fires, no LLM call happens.
  const r = await runBiographer(db, null, 1, { maxSessionBodyChars: 100 });
  assert.equal(r.processed, 1);
  // Find the skip marker
  const extracted = db
    .prepare(`SELECT payload FROM events WHERE kind = 'biographer.extracted'`)
    .all() as Array<{ payload: string }>;
  assert.equal(extracted.length, 1);
  const payload = JSON.parse(extracted[0].payload);
  assert.equal(payload.skipped, true);
  assert.equal(payload.reason, 'session_too_large');
  assert.equal(payload.threshold, 100);
  assert.ok(payload.body_chars > 100, `body_chars=${payload.body_chars} should exceed threshold`);
  closeDb(db);
});

// Silent-failure regression — when the LLM is unreachable (Ollama down), every
// chunk call fails fast with a connection error. The biographer must NOT advance
// the cursor or write a `biographer.extracted` marker (which would falsely record
// the session as done with zero entities). It must leave the session untouched
// for retry once the LLM is back. Observed live 2026-05-23 after a reboot left
// Ollama down: ~30 sessions got empty "ok" markers in seconds.
test('biographer: advances past failed chunks and finalizes when LLM unreachable', async () => {
  const db = freshDb();

  const turn = (role: string, content: string) => `[${role}]\n${content}`;
  const seg = 'word '.repeat(4400);
  const body = Array.from({ length: 4 }, (_, i) =>
    turn(i % 2 === 0 ? 'USER' : 'ASSISTANT', `segment ${i} ${seg}`),
  ).join('\n\n');
  const contentInfo = db
    .prepare(`INSERT INTO events_content (ts, body) VALUES (?, ?)`)
    .run(new Date().toISOString(), body);
  db.prepare(
    `INSERT INTO events (ts, kind, source, status, payload, content_ref) VALUES (?, 'session.captured', 'capture', 'ok', '{}', ?)`,
  ).run(new Date().toISOString(), Number(contentInfo.lastInsertRowid));

  // Provider simulating Ollama being down: every call throws a connection error.
  const provider: LLMProvider = {
    name: 'down',
    capabilities: new Set(['reasoning']),
    meta: { contextWindow: 8000, inputPricePerM: 0, outputPricePerM: 0 },
    invoke: async () => {
      throw new TypeError('fetch failed');
    },
  };
  const d = new LLMDispatcher();
  d.register('p', provider);
  d.assign('reasoning', 'p');

  // With the circuit-breaker removed, failed chunks advance the cursor and the
  // session eventually finalizes with 0 entities — the pipeline never gets stuck
  // on a single toxic session (the old `break` caused permanent stalls).
  const r = await runBiographer(db, d, 1, { maxChunksPerTick: 10 });

  // Session finalized with 0 entities (all chunks failed but cursor advanced).
  const markers = db
    .prepare(`SELECT COUNT(*) AS c FROM events WHERE kind = 'biographer.extracted'`)
    .get() as { c: number };
  assert.equal(markers.c, 1, 'session should be finalized even when all chunks fail');
  assert.equal(r.processed, 1, 'session counted as processed');
  assert.ok(r.errors.length > 0, 'errors should be recorded for the failed chunks');
  closeDb(db);
});

// Bug F regression — a session with ambiguous entities causes disambiguateEntity
// to call llm.invoke once per candidate. Before the dispatcher-level timeout,
// any one of those calls hanging would block runBiographer forever, which
// blocked Scheduler.tickOnce's `await handler(job)`, which blocked the entire
// daemon runLoop. The dispatcher now wraps every invoke in withTimeout, so a
// hung disambiguation falls into disambiguateEntity's catch path (oldest
// candidate) and the biographer run completes bounded by the timeout budget.
test('biographer: hung disambiguation does not wedge the run (Bug F)', async () => {
  const db = freshDb();

  // Seed two candidates so disambiguateEntity takes the multi-candidate LLM branch.
  upsertEntity(db, 'person', 'Ambiguous Person');
  upsertEntity(db, 'person', 'Ambiguous Person Two');

  // Provider: first call (extraction) returns a single entity matching the
  // seeded candidates; every subsequent call (disambiguation) hangs forever.
  let calls = 0;
  const provider: LLMProvider = {
    name: 'hang-on-disambig',
    capabilities: new Set(['reasoning']),
    meta: { contextWindow: 8000, inputPricePerM: 0, outputPricePerM: 0 },
    invoke: async () => {
      calls++;
      if (calls === 1) {
        return {
          text: JSON.stringify({
            entities: [{ type: 'person', name: 'Ambiguous Person' }],
            relations: [],
          }),
          usage: { inputTokens: 0, outputTokens: 0 },
          costUsd: 0,
          latencyMs: 0,
          provider: 'hang-on-disambig',
        };
      }
      return new Promise(() => {}); // never resolves
    },
  };
  const d = new LLMDispatcher();
  d.register('p', provider);
  d.assign('reasoning', 'p');

  await captureSession(db, null, {
    sessionId: 's1',
    turns: [
      { role: 'user', content: 'tell me about Ambiguous Person' },
      { role: 'assistant', content: 'Ambiguous Person did something noteworthy today.' },
    ],
  });

  const started = Date.now();
  const result = await runBiographer(db, d, 10, { disambiguationTimeoutMs: 30 });
  const elapsed = Date.now() - started;

  // The run completed despite a hung disambiguation call. Without the
  // dispatcher timeout this would hang past node:test's 20s test timeout.
  assert.equal(result.processed, 1);
  assert.ok(elapsed < 5000, `runBiographer completed in ${elapsed}ms (< 5s budget)`);
  closeDb(db);
});

// A heavy backlog drain (limit=30 sessions) must not run unbounded: an overall
// per-tick wall-clock deadline stops claiming further sessions once the budget is
// spent, yielding gracefully so the next cron tick resumes the remaining work.
// This keeps a legit-but-slow drain from overrunning the scheduler's handler cap.
test('biographer: stops at the per-tick wall-clock deadline and resumes next tick', async () => {
  const db = freshDb();
  const llm = mockLLM(
    JSON.stringify({ entities: [{ type: 'person', name: 'Kevin' }], relations: [] }),
  );

  // Three independent sessions, each a single processable chunk.
  for (let i = 0; i < 3; i++) {
    await captureSession(db, null, {
      sessionId: `s${i}`,
      turns: [
        { role: 'user', content: `session ${i}: tell me about Kevin and the project` },
        { role: 'assistant', content: `Kevin worked on project ${i} today, notably.` },
      ],
    });
  }

  // Injected clock: first read is the tick start (0); the second loop-top check
  // is still under budget (10ms), the third jumps past the 100ms deadline.
  const seq = [0, 10, 200, 200, 200, 200];
  let i = 0;
  const now = () => seq[Math.min(i++, seq.length - 1)];

  const r = await runBiographer(db, llm, 30, {
    minSessionBodyChars: 0,
    tickDeadlineMs: 100,
    now,
  });
  assert.ok(r.processed >= 1, `should process at least one session, got ${r.processed}`);
  assert.ok(r.processed < 3, `should stop early at the deadline, processed ${r.processed}`);

  // The remaining sessions survive — a normal (deadline-free) tick drains them.
  const r2 = await runBiographer(db, llm, 30, { minSessionBodyChars: 0 });
  assert.ok(r2.processed >= 1, 'remaining sessions should be processed on the next tick');
  closeDb(db);
});

// ─── isLowQualityEntity unit tests ─────────────────────────────────────────────

test('isLowQualityEntity: drops transcript role markers', () => {
  for (const name of [
    'User',
    'USER',
    'user',
    'Assistant',
    'ASSISTANT',
    'Tool',
    'system',
    'Human',
  ]) {
    assert.equal(isLowQualityEntity(name), true, `${name} should be dropped`);
  }
});

test('isLowQualityEntity: drops bare numbers and git SHA fragments', () => {
  for (const name of ['10', '404', '93f6c9c', '9736258', 'abc1234', 'ABCDEF0', 'a1b2c3d4e5f6']) {
    assert.equal(isLowQualityEntity(name), true, `${name} should be dropped`);
  }
});

test('isLowQualityEntity: drops state-flag tokens', () => {
  for (const name of ['ON', 'OFF', 'TRUE', 'false', 'Enabled', 'disabled', 'NULL', 'undefined']) {
    assert.equal(isLowQualityEntity(name), true, `${name} should be dropped`);
  }
});

test('isLowQualityEntity: drops trivial-length names', () => {
  assert.equal(isLowQualityEntity(''), true);
  assert.equal(isLowQualityEntity(' '), true);
  assert.equal(isLowQualityEntity('a'), true);
  assert.equal(isLowQualityEntity('x'.repeat(201)), true);
});

test('isLowQualityEntity: keeps legitimate entities including tech-shorthand', () => {
  for (const name of [
    'Vercel',
    'qwen3:14b',
    'VERCEL_OIDC_TOKEN', // env var, uppercase but with underscores
    'API', // 3-char acronym, NOT a state flag
    'URL',
    'CORS',
    'HTTP 404', // number with surrounding context
    'Kevin Lee',
    'leadforge',
    'Disabled by maintenance window', // contains "disabled" but is longer than 10
    'Hong Kong', // 2-word place
  ]) {
    assert.equal(isLowQualityEntity(name), false, `${name} should be kept`);
  }
});

test('isLowQualityEntity: drops engineering-internal noise from coding captures', () => {
  // The junk class observed polluting the personal graph — all carry the
  // noise-prone types thing/error/topic.
  const noise: Array<[string, string]> = [
    ['lock-cleanup', 'thing'],
    ['PID-liveness', 'thing'],
    ['dispatch hash early-exit', 'thing'],
    ['CI on main', 'topic'],
    ['check-protocol-triggers script missing', 'error'],
    ['learning-queue.md over cap', 'thing'],
    ['Disagree', 'thing'],
    ['Stress Test', 'topic'],
  ];
  for (const [name, type] of noise) {
    assert.equal(isLowQualityEntity(name, type), true, `${name} (${type}) should be dropped`);
  }
});

test('isLowQualityEntity: drops Robin self-referential internals', () => {
  // Launchd labels are noise on ANY type the LLM assigns.
  for (const type of ['service', 'tool', 'thing']) {
    assert.equal(isLowQualityEntity('io.robin-assistant.daemon', type), true);
    assert.equal(isLowQualityEntity('io.robin-assistant.backup', type), true);
  }
  // Roadmap codenames mis-typed as projects.
  for (const name of ['M0 Phase A', 'Track B Phase 1', 'Phase 4a edge', 'Sprint 3']) {
    assert.equal(isLowQualityEntity(name, 'project'), true, `${name} should be dropped`);
  }
  // Real projects with proper-noun names must survive.
  for (const name of ['leadforge', 'photo-tools', 'HostMind', 'Palisade Stays']) {
    assert.equal(isLowQualityEntity(name, 'project'), false, `${name} should be kept`);
  }
});

test('isLowQualityEntity: drops library-typed entities wholesale', () => {
  // In a personal-life graph the `library` type only ever names a code library,
  // leaked from coding-session captures. A physical library is a `place`; a
  // photo-book collection is `book`. Dropped whatever the name looks like.
  for (const name of ['Zod', 'BullMQ', 'sqlite-vec', 'vLLM', 'Drizzle ORM', 'Three.js', 'React']) {
    assert.equal(isLowQualityEntity(name, 'library'), true, `${name} (library) should be dropped`);
  }
  // Same names under a non-blocked type are NOT dropped by the type rule (the LLM
  // may legitimately re-type a real-world referent), so the loss stays scoped.
  assert.equal(isLowQualityEntity('Canvas', 'thing'), false);
});

test('isLowQualityEntity: drops bare source-file references regardless of type', () => {
  for (const name of ['biographer.ts', 'dream.test.ts', 'learning-queue.md', 'config.yaml']) {
    assert.equal(isLowQualityEntity(name), true, `${name} should be dropped`);
  }
});

test('isLowQualityEntity: keeps <Capitalized>.js frameworks but still drops .js source files', () => {
  // Framework names follow `<Cap>.js` — real entities, not source-file noise.
  // Type is 'service' or 'thing' (not 'library' — that's a blocked dev type now).
  for (const name of ['Three.js', 'Next.js 16', 'Node.js 24', 'Discord.js', 'NextAuth.js v5']) {
    assert.equal(isLowQualityEntity(name, 'service'), false, `${name} framework should be kept`);
  }
  // Lowercase/hyphenated .js source files + non-.js files are still dropped.
  for (const name of ['event-bus.js:37', 'browse.js', 'Board.tsx', 'biographer.ts']) {
    assert.equal(isLowQualityEntity(name), true, `${name} source file should be dropped`);
  }
});

test('isLowQualityEntity: keeps real entities that read like dev jargon', () => {
  // These are legitimate and must survive — concrete types are NOT subjected to
  // the dev-internal pass even when the name resembles jargon/kebab.
  // Note: 'repository', 'library', 'tool', 'env_var' are blocked types now —
  // real-world things that share those type names get re-typed as 'service' or
  // 'thing' by the LLM.
  const real: Array<[string, string]> = [
    ['OpenTable', 'service'],
    ['Antonucci Cafe', 'organization'],
    ['The Met', 'place'],
    ['Bergen County zoning', 'topic'], // 3-word real topic, no jargon
  ];
  for (const [name, type] of real) {
    assert.equal(isLowQualityEntity(name, type), false, `${name} (${type}) should be kept`);
  }
});

test('isLowQualityEntity: drops Robin-internal jargon as thing/topic', () => {
  const noise: Array<[string, string]> = [
    ['Dream pipeline', 'topic'],
    ['Daily brief generation', 'topic'],
    ['Intuition injection', 'topic'],
    ['Ingest CLI', 'topic'],
    ['recall', 'thing'],
    ['embedder batch', 'thing'],
    ['hygiene pass', 'topic'],
    ['cognition jobs', 'topic'],
    ['primer assembly', 'thing'],
  ];
  for (const [name, type] of noise) {
    assert.equal(isLowQualityEntity(name, type), true, `${name} (${type}) should be dropped`);
  }
});

test('isLowQualityEntity: drops dates, phone numbers, measurements, and vague temporals', () => {
  const noise: Array<[string, string?]> = [
    ['2026-06-09'],
    ['2026-12-31'],
    ['1989-09-08'],
    ['2026-06'],
    ['201-321-5446'],
    ['(201) 321-5446'],
    ['6.4 mm x 4.5 mm'],
    ['24.5MP'],
    ['65 BPM'],
    ['80HU'],
    ['78%'],
    ['recovery 78%'],
    ['~July'],
    ['~March 2026'],
    ['100-400mm'],
    ['120mm corner softness', 'thing'],
    ['2.5 x 1.6 cm'],
  ];
  for (const [name, type] of noise) {
    assert.equal(isLowQualityEntity(name, type), true, `"${name}" should be dropped`);
  }
});

test('isLowQualityEntity: keeps real entities that resemble measurements', () => {
  const kept = ['Nikon 100-400mm f/4.5-5.6 S', 'Bergen County NJ', 'Viltrox 85mm f/2', 'Kevin Lee'];
  for (const name of kept) {
    assert.equal(isLowQualityEntity(name), false, `"${name}" should be kept`);
  }
});

// ─── isLowQualityPredicate ────────────────────────────────────────────────────

test('isLowQualityPredicate: blocks co-occurrence fallback predicates', () => {
  const blocked = [
    'occurs_with',
    'related_to',
    'associated_with',
    'mentioned_with',
    'appears_with',
    'co-occurs_with',
    'linked_to',
    'connected_to',
  ];
  for (const p of blocked) {
    assert.equal(isLowQualityPredicate(p), true, `"${p}" should be blocked`);
  }
});

test('isLowQualityPredicate: keeps meaningful predicates', () => {
  const kept = [
    'uses',
    'works_at',
    'lives_in',
    'owns',
    'treats',
    'photographed_at',
    'directed',
    'ordered',
    'authored',
  ];
  for (const p of kept) {
    assert.equal(isLowQualityPredicate(p), false, `"${p}" should be kept`);
  }
});

// ─── new entity filters: sentences, commit prefixes, phase codenames ─────────

test('isLowQualityEntity: drops sentence-length thing/topic names', () => {
  assert.equal(
    isLowQualityEntity('Implementer subagent fixes quality issues and merges', 'thing'),
    true,
    'sentence-length thing should be dropped',
  );
  assert.equal(
    isLowQualityEntity('execute using subagent-driven development in the current session', 'topic'),
    true,
    'sentence-length topic should be dropped',
  );
});

test('isLowQualityEntity: drops conventional-commit prefixes', () => {
  const commits = [
    'chore(deps): drop unused packages',
    'feat(linear): wave 2',
    'fix(shell): offset right-rail buttons',
    'refactor(dream): nightly cognition',
  ];
  for (const name of commits) {
    assert.equal(isLowQualityEntity(name, 'thing'), true, `"${name}" should be dropped`);
  }
});

test('isLowQualityEntity: drops phase/track codenames', () => {
  const codenames = ['Phase 0', 'Phase 4a edge', 'Track B Phase 4e', 'Stage 2'];
  for (const name of codenames) {
    assert.equal(isLowQualityEntity(name, 'thing'), true, `"${name}" should be dropped`);
  }
});

test('isLowQualityEntity: keeps short real-world thing/topic names', () => {
  const real = ['Bergen County', 'Nikon Z8 autofocus', 'creatine', 'melatonin'];
  for (const name of real) {
    assert.equal(isLowQualityEntity(name, 'thing'), false, `"${name}" should be kept`);
  }
});

// ─── filter integration: runBiographer drops noise + propagates to relations ───

test('biographer: filters role markers, numbers, SHAs from extraction', async () => {
  const db = freshDb();
  // LLM emits a mix of legitimate and noise entities + relations referencing both.
  const llm = mockLLM(
    JSON.stringify({
      entities: [
        { type: 'person', name: 'Kevin', domain: 'identity' },
        { type: 'service', name: 'Vercel', domain: 'career' },
        { type: 'person', name: 'User' }, // role marker — drop
        { type: 'person', name: 'ASSISTANT' }, // role marker — drop
        { type: 'thing', name: '93f6c9c' }, // SHA — drop
        { type: 'thing', name: '10' }, // number — drop
        { type: 'thing', name: 'OFF' }, // state flag — drop
        { type: 'env_var', name: 'VERCEL_OIDC_TOKEN' }, // drop (env_var is blocked type)
      ],
      relations: [
        { subject: 'Kevin', predicate: 'uses', object: 'Vercel' }, // keep
        { subject: 'User', predicate: 'installed', object: 'Vercel' }, // drop (subject)
        { subject: 'Vercel', predicate: 'set', object: 'OFF' }, // drop (object)
        { subject: 'Vercel', predicate: 'auto-injects', object: 'VERCEL_OIDC_TOKEN' }, // drop (object blocked)
      ],
    }),
  );
  await captureSession(db, null, {
    sessionId: 's-noise',
    turns: [
      { role: 'user', content: 'set up vercel' },
      { role: 'assistant', content: 'Kevin set up Vercel with VERCEL_OIDC_TOKEN.' },
    ],
  });
  const r = await runBiographer(db, llm, 10, { minSessionBodyChars: 0 });
  assert.equal(r.processed, 1);
  // 2 legitimate entities (Kevin + Vercel), 1 legitimate relation (Kevin uses Vercel)
  // VERCEL_OIDC_TOKEN dropped (env_var is a blocked type)
  assert.equal(r.entitiesCreated, 2, `expected 2 entities, got ${r.entitiesCreated}`);
  assert.equal(r.relationsCreated, 1, `expected 1 relation, got ${r.relationsCreated}`);

  const names = (
    db.prepare('SELECT canonical_name FROM entities').all() as Array<{ canonical_name: string }>
  ).map((e) => e.canonical_name);
  assert.ok(names.includes('Kevin'));
  assert.ok(names.includes('Vercel'));
  assert.ok(
    !names.includes('VERCEL_OIDC_TOKEN'),
    'VERCEL_OIDC_TOKEN should have been filtered (env_var blocked)',
  );
  assert.ok(!names.includes('User'), 'User should have been filtered');
  assert.ok(!names.includes('ASSISTANT'), 'ASSISTANT should have been filtered');
  assert.ok(!names.includes('93f6c9c'), 'SHA should have been filtered');
  closeDb(db);
});

test('biographer: drops occurs_with relations during extraction', async () => {
  const db = freshDb();
  const llm = mockLLM(
    JSON.stringify({
      entities: [
        { type: 'person', name: 'Kevin', domain: 'identity' },
        { type: 'service', name: 'Vercel', domain: 'career' },
        { type: 'thing', name: 'Sentry', domain: 'career' },
      ],
      relations: [
        { subject: 'Kevin', predicate: 'uses', object: 'Vercel' }, // keep — meaningful
        { subject: 'Vercel', predicate: 'occurs_with', object: 'Sentry' }, // drop — noise
        { subject: 'Kevin', predicate: 'related_to', object: 'Sentry' }, // drop — noise
      ],
    }),
  );
  await captureSession(db, null, {
    sessionId: 's-occurs',
    turns: [
      { role: 'user', content: 'deploy to vercel with sentry' },
      { role: 'assistant', content: 'Kevin deploys to Vercel with Sentry monitoring.' },
    ],
  });
  const r = await runBiographer(db, llm, 10, { minSessionBodyChars: 0 });
  assert.equal(r.processed, 1);
  assert.equal(r.entitiesCreated, 3, `expected 3 entities, got ${r.entitiesCreated}`);
  assert.equal(r.relationsCreated, 1, 'only the "uses" relation should survive');
  closeDb(db);
});

// ─── knowledge.doc event processing ──────────────────────────────────────────

test('biographer: processes knowledge.doc events (not just session.captured)', async () => {
  const db = freshDb();
  const llm = mockLLM(
    JSON.stringify({
      entities: [
        { type: 'person', name: 'Kevin', domain: 'identity' },
        { type: 'place', name: 'Astoria', domain: 'home' },
      ],
      relations: [{ subject: 'Kevin', predicate: 'lives in', object: 'Astoria' }],
    }),
  );
  // Simulate what ingestContentDocs writes — a knowledge.doc event (plain markdown, no role markers)
  ingest(db, null, {
    kind: 'knowledge.doc',
    source: 'docs',
    content: 'Kevin lives in Astoria, Queens. He photographs the neighborhood often.',
    payload: { external_id: 'doc:content/knowledge/test.md', sha: 'abc123' },
  });
  const r = await runBiographer(db, llm, 10, { minSessionBodyChars: 0 });
  assert.equal(r.processed, 1, 'knowledge.doc event should be processed');
  assert.equal(r.entitiesCreated, 2);
  assert.equal(r.relationsCreated, 1);
  closeDb(db);
});

test('biographer: claims pass works on knowledge.doc (no [USER] markers needed)', async () => {
  const db = freshDb();
  const llm = dualLLM(
    JSON.stringify({ entities: [{ type: 'person', name: 'Kevin' }], relations: [] }),
    JSON.stringify({
      claims: [
        {
          topic: 'home-location',
          claim: 'Kevin lives in Astoria',
          confidence: 0.9,
          domain: 'home',
        },
      ],
    }),
  );
  ingest(db, null, {
    kind: 'knowledge.doc',
    source: 'docs',
    content: 'Kevin lives in Astoria, Queens. He is a street photographer.',
    payload: { external_id: 'doc:content/knowledge/test2.md', sha: 'def456' },
  });
  const r = await runBiographer(db, llm, 10, { minSessionBodyChars: 0, draftClaims: true });
  assert.equal(r.processed, 1);
  assert.equal(
    r.claimsDrafted,
    1,
    'claims should be drafted from knowledge.doc without [USER] markers',
  );
  closeDb(db);
});

// ─── claim-drafting second pass ────────────────────────────────────────────────

/**
 * Dispatcher whose response depends on the system prompt: the entity/relation
 * pass and the claims pass use distinct prompts, so we route by a substring
 * match. Lets a single mock drive both passes in one runBiographer call.
 */
function dualLLM(entityRelJson: string, claimsJson: string): LLMDispatcher {
  const p: LLMProvider = {
    name: 'dual',
    capabilities: new Set(['reasoning']),
    meta: { contextWindow: 8000, inputPricePerM: 0, outputPricePerM: 0 },
    invoke: async (req) => {
      const isClaims = (req.systemPrompt ?? '').includes('DURABLE PERSONAL FACTS');
      return {
        text: isClaims ? claimsJson : entityRelJson,
        usage: { inputTokens: 0, outputTokens: 0 },
        costUsd: 0,
        latencyMs: 0,
        provider: 'dual',
      };
    },
  };
  const d = new LLMDispatcher();
  d.register('d', p);
  d.assign('reasoning', 'd');
  return d;
}

test('extractClaims: parses fenced JSON and tolerates invalid output', async () => {
  const ok = mockLLM(
    '```json\n' +
      JSON.stringify({
        claims: [{ topic: 'google-role', claim: 'Ad Experiences', confidence: 0.9 }],
      }) +
      '\n```',
  );
  const okOut = await extractClaims(ok, '[USER]\nmy role is Ad Experiences', 5000, 'test');
  assert.equal(okOut.claims.length, 1);
  assert.equal(okOut.claims[0].topic, 'google-role');
  assert.equal(okOut.failure, undefined, 'a valid parse has no failure');

  // Garbage output no longer throws — it returns claims:[] with a failure reason
  // so the chunk loop can dead-letter it (decision 5).
  const bad = mockLLM('not json at all');
  const badOut = await extractClaims(bad, 'x', 5000, 'test');
  assert.deepEqual(badOut.claims, []);
  assert.ok(badOut.failure, 'unparseable output reports a failure');
});

test('extractClaims: reports parse failure distinctly from zero claims', async () => {
  // Garbage (non-JSON) → claims:[] WITH a failure reason mentioning the parse.
  const garbage = mockLLM('definitely { not ] valid JSON');
  const garbled = await extractClaims(garbage, 'x', 5000, 'test');
  assert.deepEqual(garbled.claims, []);
  assert.ok(garbled.failure && /parse/i.test(garbled.failure), 'parse failure is flagged');

  // A model that legitimately found nothing durable → claims:[] with NO failure.
  const empty = mockLLM(JSON.stringify({ claims: [] }));
  const emptyOut = await extractClaims(empty, 'x', 5000, 'test');
  assert.deepEqual(emptyOut.claims, []);
  assert.equal(emptyOut.failure, undefined, 'an empty-but-valid extraction is not a failure');
});

test('biographer: draftClaims off by default → no candidates', async () => {
  const db = freshDb();
  const llm = dualLLM(
    JSON.stringify({ entities: [{ type: 'person', name: 'Kevin' }], relations: [] }),
    JSON.stringify({ claims: [{ topic: 'home', claim: 'lives in NJ', confidence: 0.8 }] }),
  );
  await captureSession(db, null, {
    sessionId: 's1',
    turns: [
      { role: 'user', content: 'I live in New Jersey' },
      { role: 'assistant', content: 'Kevin lives in NJ.' },
    ],
  });
  const r = await runBiographer(db, llm, 10, { minSessionBodyChars: 0 });
  assert.equal(r.processed, 1);
  assert.equal(r.claimsDrafted, 0, 'no claims when draftClaims is off');
  const c = db.prepare(`SELECT COUNT(*) AS c FROM belief_candidates`).get() as { c: number };
  assert.equal(c.c, 0);
  closeDb(db);
});

test('biographer: draftClaims on → inserts pending candidates linked to the session', async () => {
  const db = freshDb();
  const llm = dualLLM(
    JSON.stringify({ entities: [{ type: 'person', name: 'Kevin' }], relations: [] }),
    JSON.stringify({
      claims: [
        { topic: 'Google Role', claim: 'Ad Experiences', confidence: 0.9, domain: 'career' },
        { topic: 'home-location', claim: 'Bergen County NJ', confidence: 0.7, domain: 'home' },
      ],
    }),
  );
  await captureSession(db, null, {
    sessionId: 's1',
    turns: [
      { role: 'user', content: 'my role at Google is Ad Experiences and I live in Bergen County' },
      { role: 'assistant', content: 'Got it.' },
    ],
  });
  const r = await runBiographer(db, llm, 10, { minSessionBodyChars: 0, draftClaims: true });
  assert.equal(r.processed, 1);
  assert.equal(r.claimsDrafted, 2);

  const cands = db
    .prepare(`SELECT topic, claim, confidence, source_event_id, status FROM belief_candidates`)
    .all() as Array<{
    topic: string;
    claim: string;
    confidence: number | null;
    source_event_id: number | null;
    status: string;
  }>;
  assert.equal(cands.length, 2);
  // topic is normalized
  assert.ok(cands.some((c) => c.topic === 'google-role'));
  assert.ok(cands.some((c) => c.topic === 'home-location'));
  // all pending, linked to the captured session event
  for (const c of cands) {
    assert.equal(c.status, 'pending');
    assert.ok(c.source_event_id && c.source_event_id > 0);
  }
  closeDb(db);
});

test('biographer: claims pass skips chunks with no [USER] content', async () => {
  const db = freshDb();
  const llm = dualLLM(
    JSON.stringify({ entities: [], relations: [] }),
    JSON.stringify({ claims: [{ topic: 'x', claim: 'should not appear', confidence: 0.5 }] }),
  );
  // Assistant/tool-only body — has role markers but no [USER]. The biographer's
  // no-human-content guard skips it entirely; either way no claims should land.
  const body = `[ASSISTANT]\n${'this is a long assistant-only turn. '.repeat(50)}`;
  const contentInfo = db
    .prepare(`INSERT INTO events_content (ts, body) VALUES (?, ?)`)
    .run(new Date().toISOString(), body);
  db.prepare(
    `INSERT INTO events (ts, kind, source, status, payload, content_ref) VALUES (?, 'session.captured', 'capture', 'ok', '{}', ?)`,
  ).run(new Date().toISOString(), Number(contentInfo.lastInsertRowid));

  const r = await runBiographer(db, llm, 10, { minSessionBodyChars: 0, draftClaims: true });
  assert.equal(r.claimsDrafted, 0);
  const c = db.prepare(`SELECT COUNT(*) AS c FROM belief_candidates`).get() as { c: number };
  assert.equal(c.c, 0);
  closeDb(db);
});

test('biographer: claims pass caps drafts per session', async () => {
  const db = freshDb();
  // Claims pass returns 30 distinct claims; the session cap is 20.
  const manyClaims = JSON.stringify({
    claims: Array.from({ length: 30 }, (_, i) => ({
      topic: `topic-${i}`,
      claim: `claim ${i}`,
      confidence: 0.5,
      domain: 'preferences',
    })),
  });
  const llm = dualLLM(JSON.stringify({ entities: [], relations: [] }), manyClaims);
  await captureSession(db, null, {
    sessionId: 's1',
    turns: [
      {
        role: 'user',
        content: 'here are a lot of durable facts about me and my world that should be drafted',
      },
      { role: 'assistant', content: 'noted all of those durable facts about you' },
    ],
  });
  const r = await runBiographer(db, llm, 10, { minSessionBodyChars: 0, draftClaims: true });
  assert.equal(r.claimsDrafted, 20, 'should cap at MAX_CLAIMS_PER_SESSION');
  const c = db.prepare(`SELECT COUNT(*) AS c FROM belief_candidates`).get() as { c: number };
  assert.equal(c.c, 20);
  closeDb(db);
});

test('biographer: a failing claims pass does not block entity/relation extraction', async () => {
  const db = freshDb();
  // Entity/relation pass succeeds; claims pass returns garbage that fails to parse.
  const p: LLMProvider = {
    name: 'claims-bad',
    capabilities: new Set(['reasoning']),
    meta: { contextWindow: 8000, inputPricePerM: 0, outputPricePerM: 0 },
    invoke: async (req) => {
      const isClaims = (req.systemPrompt ?? '').includes('DURABLE PERSONAL FACTS');
      return {
        text: isClaims
          ? 'totally not json'
          : JSON.stringify({
              entities: [{ type: 'person', name: 'Kevin', domain: 'identity' }],
              relations: [],
            }),
        usage: { inputTokens: 0, outputTokens: 0 },
        costUsd: 0,
        latencyMs: 0,
        provider: 'claims-bad',
      };
    },
  };
  const d = new LLMDispatcher();
  d.register('p', p);
  d.assign('reasoning', 'p');

  await captureSession(db, null, {
    sessionId: 's1',
    turns: [
      { role: 'user', content: 'tell me everything you know about Kevin and his background' },
      { role: 'assistant', content: 'Kevin is a person with a notable background and history.' },
    ],
  });
  const r = await runBiographer(db, d, 10, { minSessionBodyChars: 0, draftClaims: true });
  // Entity extraction still succeeded despite the claims pass throwing.
  assert.equal(r.processed, 1);
  assert.equal(r.entitiesCreated, 1);
  assert.equal(r.claimsDrafted, 0);
  assert.ok(
    r.errors.some((e) => e.includes('claims chunk')),
    'a claims-chunk error should be recorded',
  );
  // The unparseable claims chunk lands in the dead-letter queue (validation failure).
  const dead = db.prepare(`SELECT COUNT(*) AS c FROM claim_failures`).get() as { c: number };
  assert.equal(dead.c, 1, 'a parse-failed claims chunk is dead-lettered');
  closeDb(db);
});

// ─── claim-extraction dead-letter (§C3) ────────────────────────────────────────

// A claims-pass chunk whose LLM call times out (withTimeout → TimeoutError) is
// caught by the chunk loop and written to claim_failures VERBATIM so the retry
// pass can re-run the exact same text.
test('biographer: a claims-chunk timeout writes a dead letter with the verbatim chunk', async () => {
  const db = freshDb();
  // Entity/relation pass resolves; the claims pass hangs forever so its
  // withTimeout (driven by the short chunkTimeoutMs below) rejects with a
  // TimeoutError, exercising the catch-path dead-letter write.
  const p: LLMProvider = {
    name: 'claims-hang',
    capabilities: new Set(['reasoning']),
    meta: { contextWindow: 8000, inputPricePerM: 0, outputPricePerM: 0 },
    invoke: async (req) => {
      const isClaims = (req.systemPrompt ?? '').includes('DURABLE PERSONAL FACTS');
      if (isClaims) return new Promise(() => {}); // never resolves → timeout
      return {
        text: JSON.stringify({ entities: [{ type: 'person', name: 'Kevin' }], relations: [] }),
        usage: { inputTokens: 0, outputTokens: 0 },
        costUsd: 0,
        latencyMs: 0,
        provider: 'claims-hang',
      };
    },
  };
  const d = new LLMDispatcher();
  d.register('p', p);
  d.assign('reasoning', 'p');

  await captureSession(db, null, {
    sessionId: 's-timeout',
    turns: [
      { role: 'user', content: 'tell me about Kevin and his life so this chunk has user content' },
      { role: 'assistant', content: 'Kevin is a person with a documented life and history.' },
    ],
  });
  const r = await runBiographer(db, d, 10, {
    minSessionBodyChars: 0,
    draftClaims: true,
    chunkTimeoutMs: 30,
  });
  // Entity extraction still completed; the claims timeout did not block it.
  assert.equal(r.processed, 1);

  const rows = db
    .prepare(`SELECT event_id, chunk_idx, chunk_body, attempts, last_error FROM claim_failures`)
    .all() as Array<{
    event_id: number;
    chunk_idx: number;
    chunk_body: string;
    attempts: number;
    last_error: string | null;
  }>;
  assert.equal(rows.length, 1, 'the timed-out chunk is dead-lettered (single upserted row)');
  const row = rows[0];
  assert.ok(row.event_id > 0);
  assert.equal(row.chunk_idx, 0, 'single-chunk session → chunk 0');
  // The chunk loop writes the dead letter at attempts=1. The retry pass no longer
  // runs inside the biographer tick (it moved to the nightly dream pass, spec §C3),
  // so a single tick leaves the row at its initial attempt count.
  assert.equal(row.attempts, 1, 'chunk-loop write = attempts 1');
  assert.ok(
    row.last_error && /timed out|timeout/i.test(row.last_error),
    'error mentions the timeout',
  );

  // chunk_body is the VERBATIM chunk text the loop passed to extractClaims — it
  // carries the [USER] content (preprocessForExtraction keeps user turns).
  assert.ok(row.chunk_body.includes('[USER]'), 'verbatim chunk body retained');
  assert.ok(row.chunk_body.includes('tell me about Kevin'), 'verbatim user text retained');
  closeDb(db);
});

// A validation failure (model responded, output didn't parse) writes a dead
// letter; a legitimately empty extraction ({"claims":[]}) does not.
test('biographer: a validation failure dead-letters, a legitimately empty chunk does not', async () => {
  // Case A — claims pass returns garbage → one dead letter.
  const dbBad = freshDb();
  const bad: LLMProvider = {
    name: 'claims-garbage',
    capabilities: new Set(['reasoning']),
    meta: { contextWindow: 8000, inputPricePerM: 0, outputPricePerM: 0 },
    invoke: async (req) => ({
      text: (req.systemPrompt ?? '').includes('DURABLE PERSONAL FACTS')
        ? 'this is not json'
        : JSON.stringify({ entities: [], relations: [] }),
      usage: { inputTokens: 0, outputTokens: 0 },
      costUsd: 0,
      latencyMs: 0,
      provider: 'claims-garbage',
    }),
  };
  const dBad = new LLMDispatcher();
  dBad.register('p', bad);
  dBad.assign('reasoning', 'p');
  await captureSession(dbBad, null, {
    sessionId: 's-bad',
    turns: [
      { role: 'user', content: 'here is some durable content about my life worth extracting' },
      { role: 'assistant', content: 'Acknowledged, noting these durable facts about you.' },
    ],
  });
  await runBiographer(dbBad, dBad, 10, { minSessionBodyChars: 0, draftClaims: true });
  const badCount = dbBad.prepare(`SELECT COUNT(*) AS c FROM claim_failures`).get() as { c: number };
  assert.equal(badCount.c, 1, 'validation failure is dead-lettered');
  closeDb(dbBad);

  // Case B — claims pass returns a valid-but-empty extraction → no dead letter.
  const dbEmpty = freshDb();
  const llmEmpty = dualLLM(
    JSON.stringify({ entities: [], relations: [] }),
    JSON.stringify({ claims: [] }),
  );
  await captureSession(dbEmpty, null, {
    sessionId: 's-empty',
    turns: [
      { role: 'user', content: 'here is some durable content about my life worth extracting' },
      { role: 'assistant', content: 'Acknowledged, noting these durable facts about you.' },
    ],
  });
  const rEmpty = await runBiographer(dbEmpty, llmEmpty, 10, {
    minSessionBodyChars: 0,
    draftClaims: true,
  });
  assert.equal(rEmpty.claimsDrafted, 0);
  const emptyCount = dbEmpty.prepare(`SELECT COUNT(*) AS c FROM claim_failures`).get() as {
    c: number;
  };
  assert.equal(emptyCount.c, 0, 'a clean empty extraction is NOT a failure');
  closeDb(dbEmpty);
});

// Re-failing the same (event_id, chunk_idx) bumps attempts via the upsert rather
// than inserting a duplicate row — the UNIQUE(event_id, chunk_idx) constraint.
test('biographer: re-failing the same chunk bumps attempts instead of duplicating', async () => {
  const db = freshDb();
  // Pre-seed a dead letter for (event 999, chunk 0) at attempts=1.
  db.prepare(
    `INSERT INTO claim_failures (event_id, chunk_idx, chunk_body, last_error)
     VALUES (?,?,?,?)`,
  ).run(999, 0, '[USER]\noriginal chunk text', 'json parse: first failure');

  // A second failure for the same key must upsert (attempts→2), not insert.
  db.prepare(
    `INSERT INTO claim_failures (event_id, chunk_idx, chunk_body, last_error)
     VALUES (?,?,?,?)
     ON CONFLICT(event_id, chunk_idx) DO UPDATE SET
       attempts = attempts + 1, last_error = excluded.last_error, ts = datetime('now')`,
  ).run(999, 0, '[USER]\noriginal chunk text', 'schema: second failure');

  const rows = db
    .prepare(
      `SELECT attempts, last_error FROM claim_failures WHERE event_id = 999 AND chunk_idx = 0`,
    )
    .all() as Array<{ attempts: number; last_error: string }>;
  assert.equal(rows.length, 1, 'no duplicate row for the same (event_id, chunk_idx)');
  assert.equal(rows[0].attempts, 2, 'attempts bumped on re-failure');
  assert.equal(rows[0].last_error, 'schema: second failure', 'last_error updated to the latest');
  closeDb(db);
});

// ─── claim-extraction dead-letter RETRY pass (§C3, Task 8) ──────────────────────

/**
 * Claims-only dispatcher for the retry pass. `retryClaimFailures` invokes the
 * claim-extraction prompt directly; `insertCandidateWithDedup` then tries to
 * embed each surviving claim (an extra `llm.invoke`) but degrades to an exact
 * insert when the embed fails — these mocks only serve `reasoning`, so the embed
 * path falls through harmlessly. `onInvoke` lets a test count claim calls.
 */
function claimsLLM(claimsJson: string, onClaimsInvoke?: () => void): LLMDispatcher {
  const p: LLMProvider = {
    name: 'claims-only',
    capabilities: new Set(['reasoning']),
    meta: { contextWindow: 8000, inputPricePerM: 0, outputPricePerM: 0 },
    invoke: async (req) => {
      const isClaims = (req.systemPrompt ?? '').includes('DURABLE PERSONAL FACTS');
      if (isClaims) onClaimsInvoke?.();
      return {
        text: isClaims ? claimsJson : '[]',
        usage: { inputTokens: 0, outputTokens: 0 },
        costUsd: 0,
        latencyMs: 0,
        provider: 'claims-only',
      };
    },
  };
  const d = new LLMDispatcher();
  d.register('p', p);
  d.assign('reasoning', 'p');
  return d;
}

/** Seed a claim_failures row directly; returns the event id it points at. */
function seedDeadLetter(
  db: ReturnType<typeof freshDb>,
  opts: {
    eventId: number;
    chunkIdx?: number;
    chunkBody?: string;
    attempts?: number;
    ageDays?: number;
    lastError?: string;
  },
): void {
  const ts =
    opts.ageDays != null
      ? new Date(Date.now() - opts.ageDays * 86_400_000)
          .toISOString()
          .slice(0, 19)
          .replace('T', ' ')
      : null;
  db.prepare(
    `INSERT INTO claim_failures (event_id, chunk_idx, chunk_body, attempts, last_error, ts)
     VALUES (?,?,?,?,?, COALESCE(?, datetime('now')))`,
  ).run(
    opts.eventId,
    opts.chunkIdx ?? 0,
    opts.chunkBody ?? '[USER]\nmy primary camera is a Nikon Z8',
    opts.attempts ?? 1,
    opts.lastError ?? 'json parse: seeded',
    ts,
  );
}

test('retry pass re-extracts a dead letter and clears it on success', async () => {
  const db = freshDb();
  // A real source event so provenance recompute has a kind to classify.
  await captureSession(db, null, {
    sessionId: 's-retry-ok',
    turns: [
      { role: 'user', content: 'my primary camera is a Nikon Z8 and I shoot street photography' },
      { role: 'assistant', content: 'Noted — Nikon Z8 recorded as your primary camera.' },
    ],
  });
  const eventId = (
    db.prepare(`SELECT id FROM events WHERE kind = 'session.captured'`).get() as { id: number }
  ).id;
  seedDeadLetter(db, { eventId, chunkBody: '[USER]\nmy primary camera is a Nikon Z8' });

  const llm = claimsLLM(
    JSON.stringify({
      claims: [
        { topic: 'primary-camera', claim: 'Nikon Z8', confidence: 0.9, domain: 'preferences' },
      ],
    }),
  );
  const r = await retryClaimFailures(db, llm);
  assert.equal(r.retried, 1);
  assert.equal(r.recovered, 1, 'a clean re-extraction recovers the row');

  // Row deleted, candidate inserted via the normal dedup path.
  const remaining = db.prepare(`SELECT COUNT(*) AS c FROM claim_failures`).get() as { c: number };
  assert.equal(remaining.c, 0, 'recovered dead letter is deleted');
  const cands = listBeliefCandidates(db, { status: 'pending' });
  assert.equal(cands.length, 1, 'recovered claim entered the candidate queue');
  assert.equal(cands[0].topic, 'primary-camera');
  // Provenance recomputed from the source event kind (session.captured → first-party),
  // NOT hardcoded 'unknown'.
  assert.equal(cands[0].provenance, 'first-party', 'provenance recomputed from source event kind');
  closeDb(db);
});

test('a failed retry bumps attempts; attempts >= 3 rows are not retried', async () => {
  const db = freshDb();
  // One open row (attempts=1) that will re-fail, and one exhausted row (attempts=3).
  seedDeadLetter(db, { eventId: 101, chunkIdx: 0, attempts: 1 });
  seedDeadLetter(db, { eventId: 102, chunkIdx: 0, attempts: 3 });

  let claimCalls = 0;
  // Garbage claims output → extractClaims returns a failure → recordClaimFailure bumps.
  const llm = claimsLLM('not valid json', () => {
    claimCalls++;
  });
  const r = await retryClaimFailures(db, llm);
  assert.equal(r.retried, 1, 'only the open (attempts<3) row is retried');
  assert.equal(claimCalls, 1, 'the exhausted row is never sent to the LLM');
  assert.equal(r.recovered, 0);

  const open = db.prepare(`SELECT attempts FROM claim_failures WHERE event_id = 101`).get() as {
    attempts: number;
  };
  assert.equal(open.attempts, 2, 'a failed retry bumps attempts');
  const exhausted = db
    .prepare(`SELECT attempts FROM claim_failures WHERE event_id = 102`)
    .get() as { attempts: number };
  assert.equal(exhausted.attempts, 3, 'the exhausted row is untouched');
  closeDb(db);
});

// ─── Subscription-limit outage semantics ────────────────────────────────────
// A usage-limited subscription account surfaces as SubscriptionLimitError from
// the claude-agent provider (the SDK returns the limit banner as "successful"
// text). Observed live 2026-06-12: without outage handling the biographer burned
// retry attempts and finalized ~1,000 sessions with empty extractions while the
// account was Sonnet-limited for 3 days.

/** Dispatcher whose `reasoning` invokes throw SubscriptionLimitError, optionally only for claims prompts. */
function limitedLLM(opts: { onlyClaims?: boolean; entityRelJson?: string } = {}): {
  d: LLMDispatcher;
  calls: { claims: number; other: number };
} {
  const calls = { claims: 0, other: 0 };
  const p: LLMProvider = {
    name: 'limited',
    capabilities: new Set(['reasoning']),
    meta: { contextWindow: 8000, inputPricePerM: 0, outputPricePerM: 0 },
    invoke: async (req) => {
      const isClaims = (req.systemPrompt ?? '').includes('DURABLE PERSONAL FACTS');
      if (isClaims) calls.claims++;
      else calls.other++;
      if (!opts.onlyClaims || isClaims) {
        throw new SubscriptionLimitError("You've hit your Sonnet limit · resets Jun 15 at 7am");
      }
      return {
        text: opts.entityRelJson ?? JSON.stringify({ entities: [], relations: [] }),
        usage: { inputTokens: 0, outputTokens: 0 },
        costUsd: 0,
        latencyMs: 0,
        provider: 'limited',
      };
    },
  };
  const d = new LLMDispatcher();
  d.register('p', p);
  d.assign('reasoning', 'p');
  return { d, calls };
}

test('retry pass: a subscription-limit outage aborts without burning attempts', async () => {
  const db = freshDb();
  seedDeadLetter(db, { eventId: 401, chunkIdx: 0, attempts: 1, ageDays: 1 });
  seedDeadLetter(db, { eventId: 402, chunkIdx: 0, attempts: 1 });

  const { d, calls } = limitedLLM();
  const r = await retryClaimFailures(db, d);

  assert.equal(calls.claims, 1, 'the pass stops at the first outage — no further LLM calls');
  assert.equal(r.recovered, 0);
  const attempts = db
    .prepare(`SELECT event_id, attempts FROM claim_failures ORDER BY event_id`)
    .all() as Array<{ event_id: number; attempts: number }>;
  assert.deepEqual(
    attempts,
    [
      { event_id: 401, attempts: 1 },
      { event_id: 402, attempts: 1 },
    ],
    'an outage never increments attempts — the rows stay fully retryable',
  );
  closeDb(db);
});

test('entity pass: a subscription-limit outage aborts the tick without advancing the cursor', async () => {
  const db = freshDb();
  await captureSession(db, null, {
    sessionId: 's-outage',
    turns: [
      { role: 'user', content: 'my primary camera is a Nikon Z8 and I shoot street photography' },
      { role: 'assistant', content: 'Noted — Nikon Z8 recorded as your primary camera.' },
    ],
  });

  const { d, calls } = limitedLLM();
  const r = await runBiographer(db, d, 10, { minSessionBodyChars: 0, draftClaims: true });

  // No marker → the session is NOT "done"; no silent empty extraction.
  const markers = db
    .prepare(`SELECT COUNT(*) AS c FROM events WHERE kind = 'biographer.extracted'`)
    .get() as { c: number };
  assert.equal(markers.c, 0, 'no extracted marker is written during an outage');
  assert.equal(r.processed, 0, 'the session does not count as processed');

  // Progress is parked at the failed chunk so the next tick resumes exactly there.
  const progress = db
    .prepare(`SELECT next_chunk, total_chunks FROM biographer_progress`)
    .all() as Array<{ next_chunk: number; total_chunks: number }>;
  assert.equal(progress.length, 1, 'a progress row parks the session for resume');
  assert.equal(progress[0].next_chunk, 0, 'cursor still points at the failed chunk');

  // The tick aborts on the FIRST outage — claims pass and further targets never run.
  assert.equal(calls.other, 1, 'exactly one extraction call before aborting');
  assert.equal(calls.claims, 0, 'the claims pass never runs after an entity-pass outage');
  assert.match(r.errors.join('\n'), /subscription limit/i);
  closeDb(db);
});

test('claims pass: a mid-pass outage dead-letters remaining chunks without LLM calls and keeps entity work', async () => {
  const db = freshDb();
  // Two user turns big enough to land in separate chunks (CHUNK_CHARS = 20000),
  // each carrying [USER] so both are claims-eligible.
  const filler = 'I photograph street scenes in Astoria with my Nikon Z8 most weekends. '.repeat(
    170,
  );
  await captureSession(db, null, {
    sessionId: 's-claims-outage',
    turns: [
      { role: 'user', content: `first durable block: ${filler}` },
      { role: 'assistant', content: 'Noted, recording those photography habits.' },
      { role: 'user', content: `second durable block: ${filler}` },
    ],
  });
  const eventId = (
    db.prepare(`SELECT id FROM events WHERE kind = 'session.captured'`).get() as { id: number }
  ).id;

  const { d, calls } = limitedLLM({
    onlyClaims: true,
    entityRelJson: JSON.stringify({
      entities: [{ type: 'camera', name: 'Nikon Z8', domain: 'creative' }],
      relations: [],
    }),
  });
  const r = await runBiographer(db, d, 10, { minSessionBodyChars: 0, draftClaims: true });

  // Entity extraction succeeded → the session finalizes and its work is kept.
  const marker = db
    .prepare(
      `SELECT json_extract(payload, '$.entities') AS e FROM events
        WHERE kind = 'biographer.extracted' AND json_extract(payload, '$.source_event_id') = ?`,
    )
    .get(eventId) as { e: number } | undefined;
  assert.ok(marker, 'the session still finalizes — entity work is not discarded');
  assert.equal(marker?.e, 1);
  assert.equal(r.processed, 1);

  // One claims call hit the outage; every remaining eligible chunk is preserved
  // as a dead letter WITHOUT spending further LLM calls.
  assert.equal(calls.claims, 1, 'no further claims calls after the outage');
  const letters = db
    .prepare(`SELECT chunk_idx, attempts FROM claim_failures WHERE event_id = ? ORDER BY chunk_idx`)
    .all(eventId) as Array<{ chunk_idx: number; attempts: number }>;
  assert.equal(letters.length, 2, 'failed chunk AND untried chunks are all dead-lettered');
  assert.deepEqual(
    letters.map((l) => l.attempts),
    [1, 1],
  );
  assert.match(r.errors.join('\n'), /subscription limit/i);
  closeDb(db);
});

test('retry respects the per-pass cap (10 open rows, cap 5 → exactly 5 LLM calls)', async () => {
  const db = freshDb();
  for (let i = 0; i < 10; i++) seedDeadLetter(db, { eventId: 200 + i, chunkIdx: 0, attempts: 1 });

  let claimCalls = 0;
  // Each re-fails (so none are deleted) — isolates the cap behavior.
  const llm = claimsLLM('still not json', () => {
    claimCalls++;
  });
  const r = await retryClaimFailures(db, llm, { max: 5 });
  assert.equal(r.retried, 5, 'retried is bounded by the cap');
  assert.equal(claimCalls, 5, 'exactly 5 LLM claim calls for a cap of 5');
  // All 10 rows still open (5 bumped to 2, 5 still at 1) → none recovered.
  const stillOpen = db
    .prepare(`SELECT COUNT(*) AS c FROM claim_failures WHERE attempts < 3`)
    .get() as { c: number };
  assert.equal(stillOpen.c, 10);
  assert.equal(r.openBacklog, 10);
  closeDb(db);
});

test('backlog > 10 open fires the Phase-A alert; dropping to <= 10 resolves it', async () => {
  const db = freshDb();
  // 11 open rows → over the threshold of 10.
  for (let i = 0; i < 11; i++) seedDeadLetter(db, { eventId: 300 + i, chunkIdx: 0, attempts: 1 });
  // Re-fail everything so the backlog stays open and the alert fires.
  // max higher than the backlog so the count after the pass is honest (still 11 open).
  const failing = claimsLLM('garbage');
  const r1 = await retryClaimFailures(db, failing, { max: 0 });
  assert.equal(r1.openBacklog, 11, '11 open rows reported');

  const open = db
    .prepare(
      `SELECT severity, message, resolved_at FROM alerts
        WHERE source = 'biographer' AND key = 'claim-failures-backlog' AND resolved_at IS NULL`,
    )
    .get() as { severity: string; message: string; resolved_at: string | null } | undefined;
  assert.ok(open, 'a real open alert row exists');
  assert.equal(open?.severity, 'warning');
  assert.match(open?.message ?? '', /11 claim-extraction chunks/);

  // Drain below the threshold (delete 5 → 6 open), rerun → alert resolves.
  db.prepare(`DELETE FROM claim_failures WHERE event_id IN (300,301,302,303,304)`).run();
  const r2 = await retryClaimFailures(db, failing, { max: 0 });
  assert.equal(r2.openBacklog, 6);

  const stillOpen = db
    .prepare(
      `SELECT COUNT(*) AS c FROM alerts
        WHERE source = 'biographer' AND key = 'claim-failures-backlog' AND resolved_at IS NULL`,
    )
    .get() as { c: number };
  assert.equal(stillOpen.c, 0, 'the alert is resolved when the backlog drains');
  const resolved = db
    .prepare(
      `SELECT resolved_at FROM alerts
        WHERE source = 'biographer' AND key = 'claim-failures-backlog'`,
    )
    .get() as { resolved_at: string | null };
  assert.ok(resolved.resolved_at, 'resolved_at is stamped on the alert row');
  closeDb(db);
});

test('backlog alert excludes hard-outage deferrals (a throttle storm does not false-alarm)', async () => {
  const db = freshDb();
  // A usage-limit window dead-letters a whole session's remaining chunks at once
  // to PRESERVE their claims for re-extraction — those rows are waiting for the
  // account to come back, not failing. Seed 20 such deferrals + 3 genuine parse
  // failures: openBacklog=23 but genuineBacklog=3 (<=10) → NO alert.
  for (let i = 0; i < 20; i++)
    seedDeadLetter(db, {
      eventId: 500 + i,
      attempts: 1,
      lastError: 'subscription limit: empty completion (throttled account returned no text)',
    });
  for (let i = 0; i < 3; i++)
    seedDeadLetter(db, { eventId: 600 + i, attempts: 1, lastError: 'json parse: bad output' });

  // max:0 → no LLM calls; the pass just recomputes the backlog + drives the alert.
  const r = await retryClaimFailures(db, claimsLLM('garbage'), { max: 0 });
  assert.equal(r.openBacklog, 23, 'every open row counts toward the raw queue depth');
  assert.equal(r.genuineBacklog, 3, 'outage deferrals are excluded from the genuine count');

  const open = db
    .prepare(
      `SELECT COUNT(*) AS c FROM alerts
        WHERE source = 'biographer' AND key = 'claim-failures-backlog' AND resolved_at IS NULL`,
    )
    .get() as { c: number };
  assert.equal(open.c, 0, 'a throttle storm of deferrals does NOT raise the backlog alarm');
  closeDb(db);
});

test('backlog alert fires on genuine failures even amid a pile of outage deferrals', async () => {
  const db = freshDb();
  // 11 genuine parse failures (over the threshold of 10) buried under 50 outage
  // deferrals — the alert must see the 11, and report only the 11.
  for (let i = 0; i < 11; i++)
    seedDeadLetter(db, { eventId: 700 + i, attempts: 1, lastError: 'json parse: bad output' });
  for (let i = 0; i < 50; i++)
    seedDeadLetter(db, {
      eventId: 800 + i,
      attempts: 1,
      lastError: 'subscription limit: throttled',
    });

  const r = await retryClaimFailures(db, claimsLLM('garbage'), { max: 0 });
  assert.equal(r.genuineBacklog, 11);
  assert.equal(r.openBacklog, 61);
  const open = db
    .prepare(
      `SELECT message FROM alerts
        WHERE source = 'biographer' AND key = 'claim-failures-backlog' AND resolved_at IS NULL`,
    )
    .get() as { message: string } | undefined;
  assert.ok(open, 'genuine failures over the threshold still fire the alert');
  assert.match(
    open?.message ?? '',
    /^11 claim-extraction chunks/,
    'the alert counts only genuine failures, not the deferrals',
  );
  closeDb(db);
});

test('stripHarnessScaffolding removes command/caveat/stdout blocks, keeps surrounding prose', () => {
  const s =
    'real fact here <command-name>/clear</command-name> <command-message>clear</command-message>' +
    ' <local-command-caveat>DO NOT respond to these</local-command-caveat>' +
    ' <local-command-stdout>output</local-command-stdout> more real fact';
  const out = stripHarnessScaffolding(s);
  assert.doesNotMatch(out, /command-name|command-message|local-command/i);
  assert.match(out, /real fact here/);
  assert.match(out, /more real fact/);
});

test('preprocessForExtraction drops harness scaffolding + skill-prompt turns, keeps user content', () => {
  const body = [
    '[USER]',
    '<local-command-caveat>Caveat: DO NOT respond to these messages.</local-command-caveat>',
    '',
    '[USER]',
    '<command-name>/color-grade</command-name>',
    '            <command-message>color-grade</command-message>',
    '            <command-args></command-args>',
    '',
    '[USER]',
    '# /color-grade — Photo Color Grading Assistant',
    '',
    'You are a professional color grading assistant with deep knowledge of color theory and LrC.',
    '',
    '[USER]',
    'My primary camera is a Nikon Zf and I shoot street photography in Astoria most weekends.',
  ].join('\n');

  const cleaned = preprocessForExtraction(body);
  assert.doesNotMatch(cleaned, /local-command-caveat|command-name|color grading assistant/i);
  assert.match(cleaned, /Nikon Zf/, 'the one genuine user turn survives');
});

test('preprocessForExtraction drops agent/skill system-prompt turns ("You are the … analyst")', () => {
  const agentPrompts = [
    '[USER]\nYou are the MONEY analyst for Kevin’s daily brief. STYLE COVENANT: calibrated, no cheerleading. You are READ-ONLY: no write tools.',
    '[USER]\nYou are critiquing one of Kevin Lee’s photographs. Be direct, be specific, be honest. Every word should teach him about the frame.',
    '[USER]\nYou are running a nightly automated photo critique for Kevin’s photographs. Apply the SAME critique method Kevin uses interactively.',
    '[USER]\nYou are a professional color grading assistant with deep knowledge of color theory and Lightroom Classic’s processing pipeline.',
  ];
  for (const p of agentPrompts) {
    assert.equal(
      preprocessForExtraction(p).trim(),
      '',
      `system-prompt turn should be dropped: ${p.slice(8, 40)}`,
    );
  }
});

test('preprocessForExtraction keeps conversational "You are right/wrong" (not a system prompt)', () => {
  const body =
    '[USER]\nYou are wrong about the Nikon Zf — it does have IBIS, and I use it for handheld street work at night in Astoria all the time.';
  assert.match(
    preprocessForExtraction(body),
    /Nikon Zf/,
    'real user feedback is not mistaken for a system prompt',
  );
});

test('preprocessForExtraction reduces a pure slash-command session to nothing (noise)', () => {
  const body = [
    '[USER]',
    '<local-command-caveat>Caveat: DO NOT respond to these messages.</local-command-caveat>',
    '',
    '[USER]',
    '<command-name>/brief</command-name>',
    '            <command-message>brief</command-message>',
    '            <command-args></command-args>',
    '',
    '[USER]',
    '<local-command-stdout></local-command-stdout>',
  ].join('\n');
  assert.equal(
    preprocessForExtraction(body).trim(),
    '',
    'a session that is only command scaffolding cleans to empty and never reaches extraction',
  );
});

test('exhausted rows older than 30 days are pruned', async () => {
  const db = freshDb();
  // Exhausted + old → pruned. Exhausted + recent → kept (audit window). Open + old → kept (still retryable).
  seedDeadLetter(db, { eventId: 401, attempts: 3, ageDays: 45 });
  seedDeadLetter(db, { eventId: 402, attempts: 3, ageDays: 5 });
  seedDeadLetter(db, { eventId: 403, attempts: 1, ageDays: 60 });

  const llm = claimsLLM('garbage');
  await retryClaimFailures(db, llm, { max: 0 });

  const rows = db.prepare(`SELECT event_id FROM claim_failures ORDER BY event_id`).all() as Array<{
    event_id: number;
  }>;
  const ids = rows.map((r) => r.event_id);
  assert.ok(!ids.includes(401), 'exhausted + >30d old is pruned');
  assert.ok(ids.includes(402), 'exhausted but recent is kept as audit');
  assert.ok(ids.includes(403), 'open row is never pruned regardless of age');
  closeDb(db);
});

// ─── Phase D domain-gating in the retry path ─────────────────────────────────

test('retry path drops a re-extracted claim whose domain is not personal (domainGating=true)', async () => {
  const db = freshDb();
  await captureSession(db, null, {
    sessionId: 's-retry-nondomain',
    turns: [
      { role: 'user', content: 'we deployed the new microservice to staging and it passed CI' },
      { role: 'assistant', content: 'Deployment noted.' },
    ],
  });
  const eventId = (
    db.prepare(`SELECT id FROM events WHERE kind = 'session.captured'`).get() as { id: number }
  ).id;
  seedDeadLetter(db, { eventId, chunkBody: '[USER]\nwe deployed the microservice' });

  // LLM returns a non-personal (engineering) claim and an untagged claim.
  const llm = claimsLLM(
    JSON.stringify({
      claims: [
        {
          topic: 'deploy',
          claim: 'Microservice was deployed to staging',
          confidence: 0.8,
          domain: 'engineering',
        },
        { topic: 'ci', claim: 'CI passed for the staging deployment', confidence: 0.7 },
      ],
    }),
  );
  const r = await retryClaimFailures(db, llm);
  assert.equal(r.retried, 1);
  assert.equal(r.recovered, 1, 'the dead-letter row is cleared on a clean re-extraction');

  // Neither non-personal nor untagged claims should become candidates.
  const cands = listBeliefCandidates(db, { status: 'pending' });
  assert.equal(cands.length, 0, 'non-personal/untagged claims are dropped by the domain gate');
});

test('retry path inserts a personal-domain claim with domain persisted', async () => {
  const db = freshDb();
  await captureSession(db, null, {
    sessionId: 's-retry-personal',
    turns: [
      { role: 'user', content: 'my 401k contribution is 15% and I max out my HYSA every month' },
      { role: 'assistant', content: 'Finance details noted.' },
    ],
  });
  const eventId = (
    db.prepare(`SELECT id FROM events WHERE kind = 'session.captured'`).get() as { id: number }
  ).id;
  seedDeadLetter(db, { eventId, chunkBody: '[USER]\nmy 401k contribution is 15%' });

  const llm = claimsLLM(
    JSON.stringify({
      claims: [
        {
          topic: 'retirement-savings',
          claim: 'Contributes 15% to 401k',
          confidence: 0.95,
          domain: 'finance',
        },
      ],
    }),
  );
  const r = await retryClaimFailures(db, llm);
  assert.equal(r.retried, 1);
  assert.equal(r.recovered, 1);

  const cands = listBeliefCandidates(db, { status: 'pending' });
  assert.equal(cands.length, 1, 'a personal-domain claim is inserted');
  assert.equal(cands[0].topic, 'retirement-savings');
  // Query domain directly — mapRow doesn't yet expose it, so check the raw row.
  const raw = db
    .prepare(`SELECT domain FROM belief_candidates WHERE topic = 'retirement-savings'`)
    .get() as { domain: string | null } | undefined;
  assert.equal(raw?.domain, 'finance', 'domain is threaded through to the candidate row');
  closeDb(db);
});

test('retry path with domainGating=false passes non-personal claims through', async () => {
  const db = freshDb();
  await captureSession(db, null, {
    sessionId: 's-retry-nogating',
    turns: [
      { role: 'user', content: 'the build pipeline now runs in parallel across all agents' },
      { role: 'assistant', content: 'Noted.' },
    ],
  });
  const eventId = (
    db.prepare(`SELECT id FROM events WHERE kind = 'session.captured'`).get() as { id: number }
  ).id;
  seedDeadLetter(db, { eventId, chunkBody: '[USER]\nbuild pipeline parallelism' });

  const llm = claimsLLM(
    JSON.stringify({
      claims: [
        {
          topic: 'build',
          claim: 'Build pipeline runs in parallel',
          confidence: 0.8,
          domain: 'engineering',
        },
      ],
    }),
  );
  const r = await retryClaimFailures(db, llm, { domainGating: false });
  assert.equal(r.recovered, 1);

  const cands = listBeliefCandidates(db, { status: 'pending' });
  assert.equal(cands.length, 1, 'with domainGating=false, non-personal claims are inserted');
  closeDb(db);
});

// ─── P3 biographer provenance tagging tests ───────────────────────────────────

test('biographer P3: candidates from session.captured source get provenance first-party', async () => {
  const db = freshDb();
  const llm = dualLLM(
    JSON.stringify({ entities: [], relations: [] }),
    JSON.stringify({
      claims: [
        { topic: 'home', claim: 'lives in Bergen County NJ', confidence: 0.9, domain: 'home' },
      ],
    }),
  );
  // captureSession inserts a 'session.captured' event — classifyProvenance(['session.captured'])
  // → 'first-party'. Use a long enough body to pass the preprocessForExtraction
  // 50-char turn filter, otherwise the cleaned body is empty and no chunks run.
  await captureSession(db, null, {
    sessionId: 's-fp',
    turns: [
      {
        role: 'user',
        content: 'I live in Bergen County, New Jersey and have been here for several years now.',
      },
      {
        role: 'assistant',
        content: 'Noted. Bergen County NJ is recorded as your home location for future reference.',
      },
    ],
  });
  await runBiographer(db, llm, 10, { minSessionBodyChars: 0, draftClaims: true });
  const cands = listBeliefCandidates(db, { status: 'pending' });
  assert.equal(cands.length, 1);
  assert.equal(cands[0].provenance, 'first-party');
  closeDb(db);
});

test('biographer P3: classifyProvenance maps integration.* kind to external', () => {
  // Unit test of the classification helper that biographer now uses to tag
  // each candidate with the correct provenance class.
  assert.equal(classifyProvenance(['integration.github']), 'external');
  assert.equal(classifyProvenance(['integration.linear']), 'external');
  assert.equal(classifyProvenance(['integration.google_calendar']), 'external');
  // first-party wins even when mixed with external
  assert.equal(classifyProvenance(['session.captured', 'integration.github']), 'first-party');
});

test('biographer P3: insertBeliefCandidate with integration.* source stores provenance external', () => {
  // Verifies that the biographer's pattern of:
  //   1. SELECT kind FROM events WHERE id = ? (→ 'integration.github')
  //   2. classifyProvenance(['integration.github']) (→ 'external')
  //   3. insertBeliefCandidate(..., provenance: 'external')
  // correctly persists the provenance field — isolating the storage side from
  // the runBiographer path (which only processes session.captured events).
  const db = freshDb();
  const nowIso = new Date().toISOString();
  const evInfo = db
    .prepare(
      `INSERT INTO events (ts, kind, source, status, payload) VALUES (?, 'integration.github', 'github', 'ok', '{}')`,
    )
    .run(nowIso);
  const sourceEventId = Number(evInfo.lastInsertRowid);

  // Simulate the biographer's provenance lookup:
  const sourceRow = db.prepare(`SELECT kind FROM events WHERE id = ?`).get(sourceEventId) as {
    kind: string;
  };
  const prov = classifyProvenance([sourceRow.kind]);
  assert.equal(prov, 'external');

  insertBeliefCandidate(db, {
    topic: 'gh-stars',
    claim: 'repo has 42 stars',
    confidence: 0.99,
    sourceEventId,
    provenance: prov,
  });
  const cands = listBeliefCandidates(db, { status: 'pending' });
  assert.equal(cands.length, 1);
  assert.equal(cands[0].provenance, 'external');
  closeDb(db);
});

test('biographer: batch-extraction guard drops flooded entity types (>20 same type)', async () => {
  const db = freshDb();
  const songs = Array.from({ length: 25 }, (_, i) => ({
    type: 'thing',
    name: `Song Title ${i}`,
    domain: 'preferences',
  }));
  const entities = [{ type: 'person', name: 'Kevin', domain: 'identity' }, ...songs];
  const llm = mockLLM(JSON.stringify({ entities, relations: [] }));
  await captureSession(db, null, {
    sessionId: 's-flood',
    turns: [
      { role: 'user', content: 'here is my spotify playlist with 25 songs' },
      { role: 'assistant', content: `I see your playlist. ${songs.map((s) => s.name).join(', ')}` },
    ],
  });
  const r = await runBiographer(db, llm, 10, { minSessionBodyChars: 0 });
  assert.equal(r.processed, 1);
  const ents = db.prepare('SELECT canonical_name, type FROM entities').all() as Array<{
    canonical_name: string;
    type: string;
  }>;
  assert.ok(
    ents.some((e) => e.canonical_name === 'Kevin'),
    'non-flooded entity (Kevin) should survive',
  );
  assert.ok(
    !ents.some((e) => e.canonical_name === 'Song Title 0'),
    'flooded type entities should be dropped',
  );
  assert.ok(ents.length < 5, `expected few entities, got ${ents.length}`);
  closeDb(db);
});

// ─── Session finalization tests ─────────────────────────────────────────────

function finalizingLLM(extractJson: string, summaryJson: string): LLMDispatcher {
  let _callCount = 0;
  const p: LLMProvider = {
    name: 'mock',
    capabilities: new Set(['reasoning']),
    meta: { contextWindow: 8000, inputPricePerM: 0, outputPricePerM: 0 },
    invoke: async (_opts) => {
      _callCount++;
      const isFinalization =
        typeof _opts.systemPrompt === 'string' &&
        _opts.systemPrompt.includes('summarize a completed conversation');
      return {
        text: isFinalization ? summaryJson : extractJson,
        usage: { inputTokens: 0, outputTokens: 0 },
        costUsd: 0,
        latencyMs: 0,
        provider: 'mock',
      };
    },
  };
  const d = new LLMDispatcher();
  d.register('m', p);
  d.assign('reasoning', 'm');
  return d;
}

const VALID_SUMMARY: SessionSummary = {
  intent: 'Debug the whoop integration delta calculation',
  outcome: 'completed',
  outcomeSummary: 'Fixed the delta computation and added streak detection.',
  topics: ['whoop-integration', 'health-data'],
  decisions: [{ choice: 'Use 7-day rolling average', reasoning: 'Smooths daily variance' }],
  temporalRefs: [{ reference: 'by Thursday', resolvedDate: '2026-05-29' }],
  followUp: 'Wire the streak data into the daily brief skeleton',
};

test('biographer: session finalization writes summary to session payload', async () => {
  const db = freshDb();
  const llm = finalizingLLM(
    JSON.stringify({ entities: [{ type: 'person', name: 'Kevin' }], relations: [] }),
    JSON.stringify(VALID_SUMMARY),
  );
  await captureSession(db, null, {
    sessionId: 's-final',
    turns: [
      { role: 'user', content: 'fix the whoop integration delta' },
      { role: 'assistant', content: 'Done — the delta now uses a 7-day rolling average.' },
    ],
  });
  const r = await runBiographer(db, llm, 1, { minSessionBodyChars: 0 });
  assert.equal(r.processed, 1);
  assert.equal(r.sessionsSummarized, 1);

  const row = db.prepare("SELECT payload FROM events WHERE kind = 'session.captured'").get() as {
    payload: string;
  };
  const p = JSON.parse(row.payload);
  assert.ok(p.summary, 'summary should be written to session payload');
  assert.equal(p.summary.intent, VALID_SUMMARY.intent);
  assert.equal(p.summary.outcome, 'completed');
  assert.ok(p.summary.topics.includes('whoop-integration'));
  assert.ok(p.summarizedAt, 'summarizedAt timestamp should be set');
  closeDb(db);
});

test('biographer: finalization failure does not block extraction', async () => {
  const db = freshDb();
  const llm = finalizingLLM(
    JSON.stringify({
      entities: [{ type: 'person', name: 'Kevin', domain: 'identity' }],
      relations: [],
    }),
    'this is not valid JSON at all!!!',
  );
  await captureSession(db, null, {
    sessionId: 's-fail',
    turns: [
      { role: 'user', content: 'discuss camera settings for night photography' },
      { role: 'assistant', content: 'For night work with the Zf, try ISO 3200, f/2, 1/60s.' },
    ],
  });
  const r = await runBiographer(db, llm, 1, { minSessionBodyChars: 0 });
  assert.equal(r.processed, 1, 'session should still be marked processed');
  assert.equal(r.sessionsSummarized, 0, 'summary should not be counted');
  assert.equal(r.entitiesCreated, 1, 'entities should still be extracted');

  const marker = db
    .prepare("SELECT COUNT(*) AS c FROM events WHERE kind = 'biographer.extracted'")
    .get() as { c: number };
  assert.equal(marker.c, 1, 'extraction marker should still be written');
  closeDb(db);
});

test('biographer: finalization skipped for knowledge.doc events', async () => {
  const db = freshDb();
  const llm = finalizingLLM(
    JSON.stringify({ entities: [{ type: 'person', name: 'Kevin' }], relations: [] }),
    JSON.stringify(VALID_SUMMARY),
  );
  ingest(db, null, {
    kind: 'knowledge.doc',
    source: 'docs',
    content: 'Kevin is a photographer who lives in Astoria, Queens.',
    payload: { external_id: 'doc:test.md' },
  });
  const r = await runBiographer(db, llm, 1, { minSessionBodyChars: 0 });
  assert.equal(r.processed, 1);
  assert.equal(r.sessionsSummarized, 0, 'knowledge.doc should not be finalized');
  closeDb(db);
});

test('biographer: cross-session linking creates thread events on topic overlap', async () => {
  const db = freshDb();
  const summary1 = { ...VALID_SUMMARY, topics: ['leadforge-auth', 'clerk-migration'] };
  const summary2 = { ...VALID_SUMMARY, topics: ['leadforge-auth', 'clerk-migration', 'oauth'] };
  let callIdx = 0;
  const llm = finalizingLLM(
    JSON.stringify({ entities: [{ type: 'project', name: 'leadforge' }], relations: [] }),
    'placeholder',
  );
  const origInvoke = llm.invoke.bind(llm);
  llm.invoke = async (role, opts) => {
    if (
      typeof opts.systemPrompt === 'string' &&
      opts.systemPrompt.includes('summarize a completed conversation')
    ) {
      callIdx++;
      return {
        text: JSON.stringify(callIdx === 1 ? summary1 : summary2),
        usage: { inputTokens: 0, outputTokens: 0 },
        costUsd: 0,
        latencyMs: 0,
        provider: 'mock',
      };
    }
    return origInvoke(role, opts);
  };

  await captureSession(db, null, {
    sessionId: 's-thread-1',
    turns: [
      { role: 'user', content: 'start the leadforge clerk migration' },
      { role: 'assistant', content: 'Setting up Clerk for leadforge auth.' },
    ],
  });
  await runBiographer(db, llm, 1, { minSessionBodyChars: 0 });

  await captureSession(db, null, {
    sessionId: 's-thread-2',
    turns: [
      { role: 'user', content: 'continue the leadforge clerk migration callback' },
      { role: 'assistant', content: 'Wiring the OAuth callback for leadforge.' },
    ],
  });
  const r2 = await runBiographer(db, llm, 1, { minSessionBodyChars: 0 });
  assert.ok(r2.sessionsLinked >= 1, 'should create at least one thread link');

  const threads = db
    .prepare("SELECT payload FROM events WHERE kind = 'session.thread'")
    .all() as Array<{ payload: string }>;
  assert.ok(threads.length >= 1, 'session.thread event should exist');
  const tp = JSON.parse(threads[0].payload);
  assert.ok(tp.shared_topics.includes('leadforge-auth'));
  closeDb(db);
});

test('biographer: cross-session linking is capped per session (no O(N) thread fan-out)', () => {
  // When many recent sessions share the same topics (the 2026-06-13 flood: 50+
  // sessions all tagged robin/tmux-loops), the per-session fan-out exploded to
  // 1684 session.thread rows/day. Each new session must create a bounded number
  // of links regardless of how many candidates match.
  const db = freshDb();
  const topics = ['shared-a', 'shared-b'];
  const now = Date.now();
  const insertSession = (id: number, msAgo: number) =>
    db
      .prepare(
        `INSERT INTO events (id, ts, kind, source, status, payload)
         VALUES (?, ?, 'session.captured', 'capture', 'ok', ?)`,
      )
      .run(id, new Date(now - msAgo).toISOString(), JSON.stringify({ summary: { topics } }));

  // 20 prior sessions all sharing both topics, all within the 14-day window.
  for (let i = 1; i <= 20; i++) insertSession(i, i * 60_000);
  const newId = 100;
  insertSession(newId, 0);

  const linked = linkRelatedSessions(db, newId, topics);
  const threads = db
    .prepare("SELECT COUNT(*) AS c FROM events WHERE kind = 'session.thread'")
    .get() as { c: number };
  assert.ok(linked <= 8, `links per session must be capped at 8; got ${linked}`);
  assert.equal(threads.c, linked, 'thread rows must match the returned link count');
  closeDb(db);
});

// ─── Phase D: personal-domain allowlist (Task 5) ─────────────────────────────

test('claimsSchema accepts and preserves a domain tag', () => {
  const parsed = claimsSchema.parse({
    claims: [{ topic: 'home', claim: 'Kevin lives in Astoria', confidence: 0.9, domain: 'home' }],
  });
  assert.equal(parsed.claims[0].domain, 'home');
});

test('claimsSchema tolerates a missing domain (no parse failure)', () => {
  const parsed = claimsSchema.parse({ claims: [{ topic: 'x', claim: 'y' }] });
  assert.equal(parsed.claims[0].domain ?? null, null);
});

test('the claims loop drops claims whose domain is not personal', async () => {
  // The LLM returns three claims: one personal (travel), one engineering
  // (domain:'engineering', not in PERSONAL_DOMAINS), and one untagged (no domain).
  // With domainGating:true (default), only the travel claim should be inserted;
  // the other two are dropped by the allowlist gate before insertCandidateWithDedup.
  const db = freshDb();
  const llm = dualLLM(
    JSON.stringify({ entities: [], relations: [] }),
    JSON.stringify({
      claims: [
        {
          topic: 'travel-plan',
          claim: 'Kevin flies to Tokyo next week',
          confidence: 0.85,
          domain: 'travel',
        },
        {
          topic: 'fn-signature',
          claim: 'Some neutral engineering sentence about code architecture',
          confidence: 0.8,
          domain: 'engineering',
        },
        {
          topic: 'untag',
          claim: 'Another neutral sentence with no domain tag at all',
          confidence: 0.7,
          // no domain field — isPersonalDomain(undefined) → false → dropped
        },
      ],
    }),
  );
  await captureSession(db, null, {
    sessionId: 's-domain-gate',
    turns: [
      {
        role: 'user',
        content: 'I am flying to Tokyo next week to attend a photography conference.',
      },
      { role: 'assistant', content: 'Noted.' },
    ],
  });

  const r = await runBiographer(db, llm, 10, { minSessionBodyChars: 0, draftClaims: true });

  // Exactly one personal-domain claim (travel) should be drafted.
  assert.equal(r.claimsDrafted, 1, 'only the travel claim passes the allowlist gate');
  // The two non-personal claims were dropped by the gate.
  assert.equal(r.claimsDropped, 2, 'engineering + untagged claims are counted as dropped');

  // Only the personal claim is in the DB.
  const cands = db
    .prepare(`SELECT topic, domain FROM belief_candidates WHERE status = 'pending'`)
    .all() as Array<{ topic: string; domain: string | null }>;
  assert.equal(cands.length, 1, 'only one pending candidate in the queue');
  assert.equal(cands[0].topic, 'travel-plan');
  assert.equal(cands[0].domain, 'travel');

  closeDb(db);
});

// ─── entity domain-gating tests ────────────────────────────────────────────────

test('extractionSchema accepts a domain tag on entities', () => {
  const parsed = extractionSchema.parse({
    entities: [{ type: 'camera', name: 'Nikon Zf', domain: 'creative' }],
    relations: [],
  });
  assert.equal(parsed.entities[0].domain, 'creative');
});

test('entity extraction drops entities whose domain is not personal', async () => {
  // Three entities returned by the mock LLM:
  //   1. Nikon Zf (domain:'creative')   → kept (personal domain)
  //   2. SomeNeutralTool (domain:'engineering') → dropped (not in PERSONAL_DOMAINS)
  //   3. SomeoneNeutral (no domain)     → dropped (isPersonalDomain(undefined) = false)
  // A relation pointing at a dropped entity is also dropped.
  // Names are chosen to be long enough and non-flagged so isLowQualityEntity passes;
  // only the domain gate causes the drops.
  const db = freshDb();
  const llm = mockLLM(
    JSON.stringify({
      entities: [
        { type: 'camera', name: 'Nikon Zf', domain: 'creative' },
        { type: 'product', name: 'SomeNeutralTool', domain: 'engineering' },
        { type: 'person', name: 'SomeoneNeutral' /* no domain */ },
      ],
      relations: [
        { subject: 'Nikon Zf', predicate: 'owned_by', object: 'SomeoneNeutral' }, // dropped: object has no domain
        { subject: 'Nikon Zf', predicate: 'used_for', object: 'SomeNeutralTool' }, // dropped: object non-personal
      ],
    }),
  );
  await captureSession(db, null, {
    sessionId: 's-entity-domain',
    turns: [
      { role: 'user', content: 'I use my Nikon Zf for street photography sessions.' },
      { role: 'assistant', content: 'The Nikon Zf is an excellent street camera.' },
    ],
  });
  const r = await runBiographer(db, llm, 10, { minSessionBodyChars: 0 });
  assert.equal(r.processed, 1);
  // Only Nikon Zf passes the domain gate
  assert.equal(r.entitiesCreated, 1, `expected 1 entity (Nikon Zf), got ${r.entitiesCreated}`);
  assert.equal(r.relationsCreated, 0, 'all relations reference a dropped entity and are removed');

  const ents = db.prepare('SELECT canonical_name FROM entities').all() as Array<{
    canonical_name: string;
  }>;
  assert.ok(
    ents.some((e) => e.canonical_name === 'Nikon Zf'),
    'Nikon Zf (creative domain) should survive',
  );
  assert.ok(
    !ents.some((e) => e.canonical_name === 'SomeNeutralTool'),
    'SomeNeutralTool (engineering domain) should be dropped',
  );
  assert.ok(
    !ents.some((e) => e.canonical_name === 'SomeoneNeutral'),
    'SomeoneNeutral (no domain) should be dropped',
  );
  closeDb(db);
});
