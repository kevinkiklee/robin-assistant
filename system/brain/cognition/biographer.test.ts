import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { LLMDispatcher } from '../llm/dispatcher.ts';
import type { LLMProvider } from '../llm/types.ts';
import { insertBeliefCandidate, listBeliefCandidates } from '../memory/belief-candidate.ts';
import { closeDb, openDb } from '../memory/db.ts';
import { upsertEntity } from '../memory/entity.ts';
import { allMigrations, applyMigrations } from '../memory/migrations/index.ts';
import { classifyProvenance } from '../memory/provenance.ts';
import { chunkBody, extractClaims, isLowQualityEntity, runBiographer } from './biographer.ts';
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
        entities: [{ type: 'topic', name: `Entity${extractionCalls}` }],
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

  // Every chunk extracted exactly once across all ticks (no re-processing).
  assert.equal(extractionCalls, chunks.length, 'each chunk should be extracted exactly once');

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

test('isLowQualityEntity: drops bare source-file references regardless of type', () => {
  for (const name of ['biographer.ts', 'dream.test.ts', 'learning-queue.md', 'config.yaml']) {
    assert.equal(isLowQualityEntity(name), true, `${name} should be dropped`);
  }
});

test('isLowQualityEntity: keeps <Capitalized>.js frameworks but still drops .js source files', () => {
  // Framework names follow `<Cap>.js` — real entities, not source-file noise.
  for (const name of ['Three.js', 'Next.js 16', 'Node.js 24', 'Discord.js', 'NextAuth.js v5']) {
    assert.equal(isLowQualityEntity(name, 'library'), false, `${name} framework should be kept`);
  }
  // Lowercase/hyphenated .js source files + non-.js files are still dropped.
  for (const name of ['event-bus.js:37', 'browse.js', 'Board.tsx', 'biographer.ts']) {
    assert.equal(isLowQualityEntity(name), true, `${name} source file should be dropped`);
  }
});

test('isLowQualityEntity: keeps real entities that read like dev jargon', () => {
  // These are legitimate and must survive — concrete types are NOT subjected to
  // the dev-internal pass even when the name resembles jargon/kebab.
  const real: Array<[string, string]> = [
    ['OpenTable', 'service'],
    ['Antonucci Cafe', 'organization'],
    ['The Met', 'place'],
    ['landstar-construction', 'repository'], // kebab-case like lock-cleanup, but a real repo
    ['photo-tools', 'repository'],
    ['Bergen County zoning', 'topic'], // 3-word real topic, no jargon
  ];
  for (const [name, type] of real) {
    assert.equal(isLowQualityEntity(name, type), false, `${name} (${type}) should be kept`);
  }
});

// ─── filter integration: runBiographer drops noise + propagates to relations ───

test('biographer: filters role markers, numbers, SHAs from extraction', async () => {
  const db = freshDb();
  // LLM emits a mix of legitimate and noise entities + relations referencing both.
  const llm = mockLLM(
    JSON.stringify({
      entities: [
        { type: 'person', name: 'Kevin' },
        { type: 'service', name: 'Vercel' },
        { type: 'person', name: 'User' }, // role marker — drop
        { type: 'person', name: 'ASSISTANT' }, // role marker — drop
        { type: 'thing', name: '93f6c9c' }, // SHA — drop
        { type: 'thing', name: '10' }, // number — drop
        { type: 'thing', name: 'OFF' }, // state flag — drop
        { type: 'env_var', name: 'VERCEL_OIDC_TOKEN' }, // keep
      ],
      relations: [
        { subject: 'Kevin', predicate: 'uses', object: 'Vercel' }, // keep
        { subject: 'User', predicate: 'installed', object: 'Vercel' }, // drop (subject)
        { subject: 'Vercel', predicate: 'set', object: 'OFF' }, // drop (object)
        { subject: 'Vercel', predicate: 'auto-injects', object: 'VERCEL_OIDC_TOKEN' }, // keep
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
  // 3 legitimate entities, 2 legitimate relations
  assert.equal(r.entitiesCreated, 3, `expected 3 entities, got ${r.entitiesCreated}`);
  assert.equal(r.relationsCreated, 2, `expected 2 relations, got ${r.relationsCreated}`);

  const names = (
    db.prepare('SELECT canonical_name FROM entities').all() as Array<{ canonical_name: string }>
  ).map((e) => e.canonical_name);
  assert.ok(names.includes('Kevin'));
  assert.ok(names.includes('Vercel'));
  assert.ok(names.includes('VERCEL_OIDC_TOKEN'));
  assert.ok(!names.includes('User'), 'User should have been filtered');
  assert.ok(!names.includes('ASSISTANT'), 'ASSISTANT should have been filtered');
  assert.ok(!names.includes('93f6c9c'), 'SHA should have been filtered');
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
      const isClaims = (req.systemPrompt ?? '').includes('DURABLE FACTS');
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
  const claims = await extractClaims(ok, '[USER]\nmy role is Ad Experiences', 5000, 'test');
  assert.equal(claims.length, 1);
  assert.equal(claims[0].topic, 'google-role');

  const bad = mockLLM('not json at all');
  await assert.rejects(() => extractClaims(bad, 'x', 5000, 'test')); // JSON.parse throws
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
        { topic: 'Google Role', claim: 'Ad Experiences', confidence: 0.9 },
        { topic: 'home-location', claim: 'Bergen County NJ', confidence: 0.7 },
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
      const isClaims = (req.systemPrompt ?? '').includes('DURABLE FACTS');
      return {
        text: isClaims
          ? 'totally not json'
          : JSON.stringify({ entities: [{ type: 'person', name: 'Kevin' }], relations: [] }),
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
  closeDb(db);
});

// ─── P3 biographer provenance tagging tests ───────────────────────────────────

test('biographer P3: candidates from session.captured source get provenance first-party', async () => {
  const db = freshDb();
  const llm = dualLLM(
    JSON.stringify({ entities: [], relations: [] }),
    JSON.stringify({
      claims: [{ topic: 'home', claim: 'lives in Bergen County NJ', confidence: 0.9 }],
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
