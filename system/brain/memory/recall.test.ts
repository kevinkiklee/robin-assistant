import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setOperatorProfileForTests } from '../../lib/operator-profile.ts';
import { LLMDispatcher } from '../llm/dispatcher.ts';
import type { LLMProvider } from '../llm/types.ts';
import { believe } from './belief.ts';
import { closeDb, openDb } from './db.ts';
import { ingest } from './ingest.ts';
import { allMigrations, applyMigrations } from './migrations/index.ts';
import { fuseRRF, type RecallHit, recall, topScoreOf } from './recall.ts';
import { quantizeToInt8Json } from './vec-quantize.ts';

// Fixtures name the operator "Sam"; pin the profile so the name-aware topic and
// claim filters see it instead of whatever user-data/config/operator.yaml holds.
setOperatorProfileForTests({
  name: 'Sam',
  context: null,
  aliases: [],
  privateTerms: [],
  home: null,
});

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'robin-recall-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

function mockLLM(vec: number[]): LLMDispatcher {
  const provider: LLMProvider = {
    name: 'mock',
    capabilities: new Set(['embed']),
    meta: { contextWindow: 0, inputPricePerM: 0, outputPricePerM: 0 },
    invoke: async () => {
      throw new Error('nope');
    },
    embed: async () => [vec],
  };
  const d = new LLMDispatcher();
  d.register('e', provider);
  d.assign('embed', 'e');
  return d;
}

test('recall: lex mode returns FTS hits', async () => {
  const db = freshDb();
  ingest(db, null, { kind: 't', source: 's', content: 'sam loves photography in Lisbon' });
  ingest(db, null, { kind: 't', source: 's', content: 'the weather today is sunny' });

  const hits = await recall(db, null, 'Lisbon', { mode: 'lex' });
  assert.equal(hits.length, 1);
  assert.match(hits[0].body, /Lisbon/);
  closeDb(db);
});

test('recall: lex returns empty when no matches', async () => {
  const db = freshDb();
  const hits = await recall(db, null, 'nonexistent', { mode: 'lex' });
  assert.equal(hits.length, 0);
  closeDb(db);
});

test('recall: logs every query to recall_log with result count', async () => {
  const db = freshDb();
  ingest(db, null, { kind: 't', source: 's', content: 'sam loves photography in Lisbon' });

  await recall(db, null, 'Lisbon', { mode: 'lex' });
  // Hyphen would crash a naive FTS5 query (treated as NOT operator) — the sanitizer
  // strips it. Combined with the never-seen word, this asserts both "logs even when
  // no hits" and "doesn't crash on natural-language punctuation."
  await recall(db, null, 'nonexistent-thing-xyz', { mode: 'lex' });

  const rows = db
    .prepare(`SELECT query_hash, result_count, outcome FROM recall_log ORDER BY id`)
    .all() as Array<{ query_hash: string; result_count: number; outcome: string }>;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].result_count, 1);
  assert.equal(rows[0].outcome, 'answered'); // ≥1 hit → answered, set at log time
  assert.equal(rows[1].result_count, 0);
  assert.equal(rows[1].outcome, 'miss'); // 0 hits → miss, no longer stuck 'pending'
  // Distinct hashes for distinct queries
  assert.notEqual(rows[0].query_hash, rows[1].query_hash);
  closeDb(db);
});

test('recall: stores top_score, session_id, and surfaced content ids', async () => {
  const db = freshDb();
  ingest(db, null, { kind: 't', source: 's', content: 'sam loves photography in Lisbon' });
  const hits = await recall(db, null, 'Lisbon', { mode: 'lex', sessionId: 'sess-42' });
  assert.equal(hits.length, 1);
  const row = db
    .prepare(
      `SELECT outcome, top_score, session_id, injected_content_ids FROM recall_log ORDER BY id DESC LIMIT 1`,
    )
    .get() as {
    outcome: string;
    top_score: number | null;
    session_id: string | null;
    injected_content_ids: string | null;
  };
  assert.equal(row.outcome, 'answered');
  assert.equal(typeof row.top_score, 'number');
  assert.equal(row.session_id, 'sess-42');
  const ids = JSON.parse(row.injected_content_ids ?? '[]') as number[];
  assert.deepEqual(ids, [hits[0].contentId]);
  closeDb(db);
});

test('recall: a miss stores no top_score and an empty content-id set', async () => {
  const db = freshDb();
  await recall(db, null, 'nothing-here-zzz', { mode: 'lex', sessionId: 'sess-7' });
  const row = db
    .prepare(
      `SELECT outcome, top_score, session_id, injected_content_ids FROM recall_log ORDER BY id DESC LIMIT 1`,
    )
    .get() as {
    outcome: string;
    top_score: number | null;
    session_id: string | null;
    injected_content_ids: string | null;
  };
  assert.equal(row.outcome, 'miss');
  assert.equal(row.top_score, null);
  assert.equal(row.session_id, 'sess-7');
  assert.deepEqual(JSON.parse(row.injected_content_ids ?? '[]'), []);
  closeDb(db);
});

test('recall: repeat queries share the same query_hash so aggregation is meaningful', async () => {
  const db = freshDb();
  ingest(db, null, { kind: 't', source: 's', content: 'a body about Lisbon' });
  await recall(db, null, 'Lisbon', { mode: 'lex' });
  await recall(db, null, 'Lisbon', { mode: 'lex' });
  const rows = db.prepare(`SELECT query_hash FROM recall_log`).all() as Array<{
    query_hash: string;
  }>;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].query_hash, rows[1].query_hash);
  closeDb(db);
});

test('recall: belief.update hit carries confidence, provenance, ageDays; non-belief hit does not', async () => {
  const db = freshDb();
  // Seed a belief.update event
  believe(db, null, {
    topic: 'test.role',
    claim: 'Software Engineer',
    confidence: 0.9,
    provenance: 'first-party',
    date: '2026-05-23',
  });
  // Seed a non-belief event
  ingest(db, null, { kind: 'memory.remember', source: 's', content: 'Software Engineer at Acme' });

  const hits = await recall(db, null, 'Software Engineer', { mode: 'lex' });
  // At least one hit
  assert.ok(hits.length >= 1);

  const beliefHit = hits.find((h) => h.kind === 'belief.update');
  assert.ok(beliefHit, 'should have a belief.update hit');
  assert.ok(typeof beliefHit.ageDays === 'number' && beliefHit.ageDays >= 0);
  assert.equal(typeof beliefHit.confidence, 'number');
  assert.equal(beliefHit.provenance, 'first-party');

  const nonBeliefHit = hits.find((h) => h.kind !== 'belief.update');
  assert.ok(nonBeliefHit, 'should have a non-belief hit');
  assert.equal(typeof nonBeliefHit.ageDays, 'number');
  assert.equal(nonBeliefHit.confidence, undefined);
  assert.equal(nonBeliefHit.provenance, undefined);

  closeDb(db);
});

test('recall: enrichment is best-effort — non-belief hits carry kind + ageDays only', async () => {
  const db = freshDb();
  ingest(db, null, { kind: 'session.captured', source: 's', content: 'favorite color is blue' });

  const hits = await recall(db, null, 'favorite color', { mode: 'lex' });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].kind, 'session.captured');
  assert.equal(typeof hits[0].ageDays, 'number');
  assert.equal(hits[0].confidence, undefined);
  assert.equal(hits[0].provenance, undefined);

  closeDb(db);
});

test('recall: vec mode finds the row whose embedding the dispatcher returned', async () => {
  // ingest no longer embeds inline (deferred to the embedder job), so this test
  // writes the vector directly into events_content + events_vec to set up the recall
  // surface, then verifies vec recall works against the seeded data.
  const db = freshDb();
  const targetVec = new Array(3072).fill(0.0);
  targetVec[0] = 1.0;
  const llm = mockLLM(targetVec);
  const r = ingest(db, llm, {
    kind: 't',
    source: 's',
    content: 'sam loves photography in Lisbon',
  });
  assert.ok(r.contentId);
  // events_vec is int8 (migration 023); store a sentinel in events_content + the int8 vector.
  db.prepare('UPDATE events_content SET embedding = ? WHERE id = ?').run(
    Buffer.from([1]),
    r.contentId,
  );
  // vec0 requires BigInt rowid binding (rejects JS Number with "only integers allowed").
  db.prepare('INSERT INTO events_vec(rowid, embedding) VALUES (?, vec_int8(?))').run(
    BigInt(r.contentId),
    quantizeToInt8Json(targetVec),
  );

  const hits = await recall(db, llm, 'unrelated query', { mode: 'vec' });
  assert.equal(hits.length, 1);
  assert.match(hits[0].body, /Lisbon/);
  closeDb(db);
});

test('fuseRRF: an item ranked in both lists outranks items in only one', () => {
  const mk = (contentId: number): RecallHit => ({
    eventId: contentId,
    contentId,
    body: `body-${contentId}`,
    score: 0,
    source: 'lex',
  });
  // lex order: [1, 2]; vec order: [2, 3]. Item 2 appears (well-ranked) in BOTH lists,
  // so RRF lifts it above item 1 (lex-only #1) and item 3 (vec-only #2).
  const out = fuseRRF(
    [
      [mk(1), mk(2)],
      [mk(2), mk(3)],
    ],
    10,
  );
  assert.deepEqual(
    out.map((h) => h.contentId),
    [2, 1, 3],
  );
});

test('fuseRRF: respects the limit', () => {
  const mk = (contentId: number): RecallHit => ({
    eventId: contentId,
    contentId,
    body: `b${contentId}`,
    score: 0,
    source: 'vec',
  });
  const out = fuseRRF([[mk(1), mk(2), mk(3), mk(4)]], 2);
  assert.equal(out.length, 2);
  assert.deepEqual(
    out.map((h) => h.contentId),
    [1, 2],
  );
});

test('recall: maxDistance floor drops vec hits beyond the L2 threshold', async () => {
  const db = freshDb();
  // Two orthogonal UNIT vectors with components spread across many dims (~0.0255 each) so
  // int8 quantization doesn't clip — preserving the float L2 distance √2 ≈ 1.414 through
  // the int8 round-trip. (One-hot vectors with a single 1.0 component would clip to 127
  // and distort the distance.)
  const dim = 3072;
  const half = dim / 2;
  const e0 = new Array(dim).fill(0);
  for (let i = 0; i < half; i++) e0[i] = 1 / Math.sqrt(half);
  const e1 = new Array(dim).fill(0);
  for (let i = half; i < dim; i++) e1[i] = 1 / Math.sqrt(half);
  const near = ingest(db, null, { kind: 't', source: 's', content: 'near apple' });
  const far = ingest(db, null, { kind: 't', source: 's', content: 'far banana' });
  const put = (contentId: number, vecArr: number[]) => {
    db.prepare('UPDATE events_content SET embedding = ? WHERE id = ?').run(
      Buffer.from([1]),
      contentId,
    );
    db.prepare('INSERT INTO events_vec(rowid, embedding) VALUES (?, vec_int8(?))').run(
      BigInt(contentId),
      quantizeToInt8Json(vecArr),
    );
  };
  put(near.contentId as number, e0);
  put(far.contentId as number, e1);
  const llm = mockLLM(e0); // the query embeds to e0

  const noFloor = await recall(db, llm, 'q', { mode: 'vec' });
  assert.equal(noFloor.length, 2, 'without a floor both rows return');

  const floored = await recall(db, llm, 'q', { mode: 'vec', maxDistance: 1.0 });
  assert.equal(floored.length, 1, 'the floor drops the orthogonal (distance √2) row');
  assert.match(floored[0].body, /near/);
  closeDb(db);
});

test('recall: truncates the query to 2000 chars before embedding', async () => {
  const db = freshDb();
  let seen = '';
  const provider: LLMProvider = {
    name: 'capture',
    capabilities: new Set(['embed']),
    meta: { contextWindow: 0, inputPricePerM: 0, outputPricePerM: 0 },
    invoke: async () => {
      throw new Error('nope');
    },
    embed: async (text) => {
      seen = Array.isArray(text) ? (text[0] ?? '') : text;
      return [new Array(3072).fill(0)];
    },
  };
  const d = new LLMDispatcher();
  d.register('e', provider);
  d.assign('embed', 'e');

  await recall(db, d, 'x'.repeat(3000), { mode: 'vec' });
  assert.equal(seen.length, 2000);
  closeDb(db);
});

test('recall: a retracted belief is not surfaced (its superseded original stays indexed)', async () => {
  const db = freshDb();
  // Original assertion, later retracted with no replacement. The fixture must be a life-fact: machinery claims (the old
  // SurrealDB-backend example) are now blocked at write time by the
  // dev-artifact backstop in `believe()` and never reach the index.
  const orig = believe(db, null, {
    topic: 'sam.swim',
    claim: 'Sam swims daily at Harbortown Pool',
    date: '2026-05-28',
  });
  believe(db, null, {
    topic: 'sam.swim',
    claim: 'Sam swims daily at Harbortown Pool',
    retracted: true,
    supersedes: orig.eventId,
    date: '2026-05-29',
  });

  const hits = await recall(db, null, 'Harbortown Pool swims', { mode: 'lex' });
  assert.equal(
    hits.filter((h) => h.kind === 'belief.update').length,
    0,
    'no belief.update hit should surface for a retracted topic',
  );
  closeDb(db);
});

test('recall: a current non-retracted belief is still surfaced', async () => {
  const db = freshDb();
  believe(db, null, {
    topic: 'role',
    claim: 'Sam is a software engineer at Acme',
    confidence: 0.9,
    date: '2026-05-29',
  });
  const hits = await recall(db, null, 'software engineer Acme', { mode: 'lex' });
  const beliefHit = hits.find((h) => h.kind === 'belief.update');
  assert.ok(beliefHit, 'the live belief head must still be recallable');
  assert.match(beliefHit.body, /software engineer/i);
  closeDb(db);
});

test('recall: a superseded-but-replaced belief surfaces only the head, not the old event', async () => {
  const db = freshDb();
  const orig = believe(db, null, {
    topic: 'city',
    claim: 'Sam lives in Harbortown metropolis',
    date: '2026-05-20',
  });
  believe(db, null, {
    topic: 'city',
    claim: 'Sam lives in Lakeport metropolis',
    supersedes: orig.eventId,
    date: '2026-05-29',
  });
  const hits = await recall(db, null, 'metropolis', { mode: 'lex' });
  const beliefHits = hits.filter((h) => h.kind === 'belief.update');
  assert.equal(beliefHits.length, 1, 'only the current head should surface');
  assert.match(beliefHits[0].body, /Lakeport/);
  assert.ok(
    !beliefHits.some((h) => /Harbortown/.test(h.body)),
    'the superseded original must be dropped',
  );
  closeDb(db);
});

test('migration: recall_log has a nullable kept_json column', () => {
  const db = freshDb();
  const cols = db.prepare(`PRAGMA table_info(recall_log)`).all() as Array<{
    name: string;
    notnull: number;
  }>;
  const kept = cols.find((c) => c.name === 'kept_json');
  assert.ok(kept, 'kept_json column must exist on recall_log');
  assert.equal(kept.notnull, 0, 'kept_json must be nullable (no backfill)');
  closeDb(db);
});

test('recall: onLogged receives the rowid of the recall_log row just written', async () => {
  const db = freshDb();
  ingest(db, null, { kind: 't', source: 's', content: 'sam loves photography in Lisbon' });
  let logRowId: number | undefined;
  await recall(db, null, 'Lisbon', {
    mode: 'lex',
    onLogged: (id) => {
      logRowId = id;
    },
  });
  assert.equal(typeof logRowId, 'number');
  const row = db.prepare(`SELECT query_hash FROM recall_log WHERE id = ?`).get(logRowId) as
    | { query_hash: string }
    | undefined;
  assert.ok(row, 'the rowid must SELECT back to the row just written');
  // Same hash idiom logRecall uses — proves the id points at THIS query's row.
  assert.equal(row.query_hash, Buffer.from('Lisbon').toString('base64').slice(0, 64));
  closeDb(db);
});

test("recall: a throwing onLogged does not break recall()'s return or the log write", async () => {
  const db = freshDb();
  ingest(db, null, { kind: 't', source: 's', content: 'sam loves photography in Lisbon' });
  const hits = await recall(db, null, 'Lisbon', {
    mode: 'lex',
    onLogged: () => {
      throw new Error('caller bug');
    },
  });
  assert.equal(hits.length, 1, 'recall must still return its hits');
  const count = db.prepare(`SELECT COUNT(*) AS n FROM recall_log`).get() as { n: number };
  assert.equal(count.n, 1, 'the log row must still have been written');
  closeDb(db);
});

test('recall: tags recall_log rows with the source (auto vs manual)', async () => {
  const db = freshDb();
  ingest(db, null, { kind: 't', source: 's', content: 'lisbon photos' });
  await recall(db, null, 'lisbon', { mode: 'lex', source: 'auto' });
  await recall(db, null, 'lisbon', { mode: 'lex' }); // defaults to manual
  const rows = db.prepare('SELECT source FROM recall_log ORDER BY id').all() as Array<{
    source: string;
  }>;
  assert.deepEqual(
    rows.map((r) => r.source),
    ['auto', 'manual'],
  );
  closeDb(db);
});

// ── kinds filter, lexical floors, honest top_score (2026-10-03) ──────────────────

/** Small-magnitude 3072-dim vector (int8 scale 400 clips above ~0.32 per component). */
function vec2(a: number, b: number): number[] {
  const v = new Array(3072).fill(0);
  v[0] = a;
  v[1] = b;
  return v;
}

function seedEmbedding(db: ReturnType<typeof freshDb>, contentId: number, v: number[]): void {
  db.prepare('UPDATE events_content SET embedding = ? WHERE id = ?').run(
    Buffer.from([1]),
    contentId,
  );
  db.prepare('INSERT INTO events_vec(rowid, embedding) VALUES (?, vec_int8(?))').run(
    BigInt(contentId),
    quantizeToInt8Json(v),
  );
}

const Q = vec2(0.25, 0);

test('recall: punctuation-heavy prompts no longer crash the lexical branch', async () => {
  const db = freshDb();
  ingest(db, null, { kind: 't', source: 's', content: 'Lakeport lodge is booked solid' });
  const hits = await recall(db, null, "also lakeport lodge's full? [Image #3] <x/>", {
    mode: 'lex',
    lexMatch: 'any',
  });
  assert.equal(hits.length, 1);
  closeDb(db);
});

test('recall: lex kinds filter applies before the LIMIT (junk cannot crowd out curated)', async () => {
  const db = freshDb();
  for (let i = 0; i < 30; i++) {
    ingest(db, null, {
      kind: 'session.captured',
      source: 's',
      content: `lisbon trip transcript ${i} lisbon lisbon`,
    });
  }
  ingest(db, null, {
    kind: 'belief.update',
    source: 's',
    content: 'lisbon trip curated',
    payload: { topic: 'lisbon' },
  });

  const unfiltered = await recall(db, null, 'lisbon trip', { mode: 'lex', limit: 5 });
  assert.ok(
    unfiltered.every((h) => h.kind === 'session.captured'),
    'baseline: transcripts fill the pool',
  );

  const hits = await recall(db, null, 'lisbon trip', {
    mode: 'lex',
    limit: 5,
    kinds: ['belief.update', 'knowledge.doc'],
  });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].kind, 'belief.update');
  closeDb(db);
});

test('recall: vec kinds filter over-fetches past nearer non-curated rows', async () => {
  const db = freshDb();
  const llm = mockLLM(Q);
  // 20 transcripts nearer to the query than the one curated doc.
  for (let i = 0; i < 20; i++) {
    const r = ingest(db, null, {
      kind: 'session.captured',
      source: 's',
      content: `transcript ${i}`,
    });
    seedEmbedding(db, r.contentId as number, vec2(0.25, 0.001 * (i + 1)));
  }
  const doc = ingest(db, null, { kind: 'knowledge.doc', source: 's', content: 'curated doc' });
  seedEmbedding(db, doc.contentId as number, vec2(0.25, 0.05));

  const plain = await recall(db, llm, 'zzz', { mode: 'vec', limit: 5 });
  assert.ok(plain.every((h) => h.kind === 'session.captured'));

  const hits = await recall(db, llm, 'zzz', { mode: 'vec', limit: 5, kinds: ['knowledge.doc'] });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].kind, 'knowledge.doc');
  assert.ok(hits[0].distance !== undefined && Math.abs(hits[0].distance - 0.05) < 0.01);
  closeDb(db);
});

test('recall: lexMaxDistance keeps a lex hit only when the vector branch corroborates it', async () => {
  const db = freshDb();
  const llm = mockLLM(Q);
  const near = ingest(db, null, {
    kind: 'knowledge.doc',
    source: 's',
    content: 'heron rookery near',
  });
  seedEmbedding(db, near.contentId as number, vec2(0.25, 0.1)); // d = 0.10
  const far = ingest(db, null, {
    kind: 'knowledge.doc',
    source: 's',
    content: 'heron rookery far',
  });
  seedEmbedding(db, far.contentId as number, vec2(0, 0.25)); // d ≈ 0.354
  // Un-embedded row (embedder lag): judged by the bm25 term floor instead.
  ingest(db, null, { kind: 'knowledge.doc', source: 's', content: 'heron rookery pending' });

  const strict = await recall(db, llm, 'heron rookery', {
    mode: 'hybrid',
    lexMatch: 'any',
    kinds: ['knowledge.doc'],
    maxDistance: 0.05, // the vec branch alone admits nothing
    lexMaxDistance: 0.2,
    lexMinTermScore: 1e9, // and the un-embedded fallback is impossible to pass
  });
  assert.deepEqual(
    strict.map((h) => h.body),
    ['heron rookery near'],
  );
  assert.ok(strict[0].distance !== undefined && Math.abs(strict[0].distance - 0.1) < 0.01);

  const lenient = await recall(db, llm, 'heron rookery', {
    mode: 'hybrid',
    lexMatch: 'any',
    kinds: ['knowledge.doc'],
    maxDistance: 0.05,
    lexMaxDistance: 0.2,
    lexMinTermScore: 0,
  });
  assert.deepEqual(lenient.map((h) => h.body).sort(), [
    'heron rookery near',
    'heron rookery pending',
  ]);
  closeDb(db);
});

test('recall: lexMinTermScore drops weak bm25 matches in lex mode', async () => {
  const db = freshDb();
  ingest(db, null, { kind: 't', source: 's', content: 'sam loves photography in Lisbon' });
  const kept = await recall(db, null, 'lisbon', { mode: 'lex', lexMinTermScore: 0 });
  assert.equal(kept.length, 1);
  const dropped = await recall(db, null, 'lisbon', { mode: 'lex', lexMinTermScore: 1e9 });
  assert.equal(dropped.length, 0);
  closeDb(db);
});

test('topScoreOf: best vector similarity when any hit has a distance, else raw top score', () => {
  const h = (score: number, distance?: number): RecallHit => ({
    eventId: 1,
    contentId: 1,
    body: '',
    score,
    source: distance === undefined ? 'lex' : 'vec',
    ...(distance === undefined ? {} : { distance }),
  });
  assert.equal(topScoreOf([]), null);
  assert.equal(topScoreOf([h(1 / 60), h(1 / 61, 0.7), h(1 / 62, 0.75)]), 1 - 0.7);
  assert.equal(topScoreOf([h(12.5), h(9)]), 12.5);
});

test('recall: hybrid recall_log.top_score is the vector similarity, not the constant 1/60', async () => {
  const db = freshDb();
  const llm = mockLLM(Q);
  const r = ingest(db, null, { kind: 'knowledge.doc', source: 's', content: 'egret colony' });
  seedEmbedding(db, r.contentId as number, vec2(0.25, 0.1));
  await recall(db, llm, 'egret colony', { mode: 'hybrid' });
  const row = db.prepare('SELECT top_score FROM recall_log').get() as { top_score: number };
  assert.ok(Math.abs(row.top_score - 0.9) < 0.01, `top_score ${row.top_score}`);
  closeDb(db);
});
