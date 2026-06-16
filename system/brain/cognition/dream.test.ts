import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { LLMDispatcher } from '../llm/dispatcher.ts';
import type { LLMProvider } from '../llm/types.ts';
import { believe } from '../memory/belief.ts';
import { insertBeliefCandidate } from '../memory/belief-candidate.ts';
import { closeDb, openDb } from '../memory/db.ts';
import { addRelation, upsertEntity } from '../memory/entity.ts';
import { ingest } from '../memory/ingest.ts';
import { allMigrations, applyMigrations } from '../memory/migrations/index.ts';
import type { DreamResult, LearningDigest } from './dream.ts';
import {
  composeLearningDigest,
  detectArcs,
  latestLearningDigest,
  promoteStableCandidates,
  queryApproachingDeadlines,
  queryDecisionReplays,
  queryPredictionCalibration,
  renderLearningDigest,
  runDream,
  summarizeHotEntities,
} from './dream.ts';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'robin-dream-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

/**
 * Fresh DB plus an isolated user-data dir wired via ROBIN_USER_DATA_DIR, so
 * `flagStaleNarrativeDocs` reads `<dir>/content/profile/` from a temp tree.
 * Returns a teardown that closes the DB and restores the env var.
 */
function freshDbWithUserDataDir() {
  const dir = mkdtempSync(join(tmpdir(), 'robin-dream-ud-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  const prev = process.env.ROBIN_USER_DATA_DIR;
  process.env.ROBIN_USER_DATA_DIR = dir;
  const teardown = () => {
    closeDb(db);
    if (prev === undefined) delete process.env.ROBIN_USER_DATA_DIR;
    else process.env.ROBIN_USER_DATA_DIR = prev;
  };
  return { db, dir, teardown };
}

/** Write a profile doc and force its mtime to `at` (epoch ms). */
function writeProfileDoc(dir: string, name: string, body: string, at: number) {
  const profileDir = join(dir, 'content', 'profile');
  mkdirSync(profileDir, { recursive: true });
  const path = join(profileDir, name);
  writeFileSync(path, body);
  const secs = at / 1000;
  utimesSync(path, secs, secs);
}

test('dream: resolves overdue predictions as unverifiable', async () => {
  const db = freshDb();
  const yesterday = new Date(Date.now() - 86400 * 1000).toISOString();
  db.prepare(`INSERT INTO predictions (claim, confidence, deadline) VALUES (?, ?, ?)`).run(
    'it will rain',
    0.7,
    yesterday,
  );
  const r = await runDream(db, null);
  assert.equal(r.predictionsResolved, 1);
  const row = db.prepare(`SELECT outcome, evidence FROM predictions LIMIT 1`).get() as {
    outcome: string;
    evidence: string | null;
  };
  assert.equal(row.outcome, 'unverifiable');
  assert.ok(
    row.evidence && /Auto-resolved as unverifiable/.test(row.evidence),
    'expected auto-resolver to record a reason in evidence',
  );
  closeDb(db);
});

test('dream: generates a journal for today', async () => {
  const db = freshDb();
  await runDream(db, null);
  const day = new Date().toISOString().slice(0, 10);
  const row = db.prepare(`SELECT body FROM journals WHERE day = ?`).get(day) as { body: string };
  assert.ok(row);
  assert.match(row.body, /Robin Journal/);
  closeDb(db);
});

test('dream: writes metrics_daily counts', async () => {
  const db = freshDb();
  await runDream(db, null);
  const day = new Date().toISOString().slice(0, 10);
  const rows = db
    .prepare(`SELECT metric, value FROM metrics_daily WHERE day = ?`)
    .all(day) as Array<{
    metric: string;
    value: number;
  }>;
  const metrics = new Set(rows.map((r) => r.metric));
  assert.ok(metrics.has('events_count'));
  assert.ok(metrics.has('captures_count'));
  assert.ok(metrics.has('corrections_count'));
  closeDb(db);
});

function mockLLM(text: string): LLMDispatcher {
  const p: LLMProvider = {
    name: 'mock',
    capabilities: new Set(['summarize', 'reasoning']),
    meta: { contextWindow: 8000, inputPricePerM: 0, outputPricePerM: 0 },
    invoke: async () => ({
      text,
      usage: { inputTokens: 0, outputTokens: 0 },
      costUsd: 0,
      latencyMs: 0,
      provider: 'mock',
    }),
  };
  const d = new LLMDispatcher();
  d.register('m', p);
  d.assign('summarize', 'm');
  d.assign('reasoning', 'm');
  return d;
}

function insertCapture(db: ReturnType<typeof freshDb>, ts: string): number {
  const c = db.prepare(`INSERT INTO events_content (ts, body) VALUES (?, ?)`).run(ts, 'body');
  const e = db
    .prepare(
      `INSERT INTO events (ts, kind, source, status, payload, content_ref) VALUES (?, 'session.captured', 'capture', 'ok', '{}', ?)`,
    )
    .run(ts, Number(c.lastInsertRowid));
  return Number(e.lastInsertRowid);
}

test('summarizeHotEntities: skips silently with no LLM', async () => {
  const db = freshDb();
  const count = await summarizeHotEntities(db, null, new Date().toISOString());
  assert.equal(count, 0);
  closeDb(db);
});

test('summarizeHotEntities: rewrites profile when entity has >= threshold signals today', async () => {
  const db = freshDb();
  const kevin = upsertEntity(db, 'person', 'Kevin', 'old profile');
  const lisbon = upsertEntity(db, 'place', 'Lisbon');
  const porto = upsertEntity(db, 'place', 'Porto');
  const tokyo = upsertEntity(db, 'place', 'Tokyo');
  const eventId = insertCapture(db, new Date().toISOString());
  addRelation(db, kevin.id, 'visited', lisbon.id, eventId);
  addRelation(db, kevin.id, 'visited', porto.id, eventId);
  addRelation(db, kevin.id, 'visited', tokyo.id, eventId);

  const llm = mockLLM('Kevin recently visited multiple cities including Lisbon, Porto, and Tokyo.');
  const since = new Date(Date.now() - 1000).toISOString();
  const count = await summarizeHotEntities(db, llm, since);
  assert.ok(count >= 1, `expected >=1 summarized, got ${count}`);

  const updated = db.prepare(`SELECT profile FROM entities WHERE id = ?`).get(kevin.id) as {
    profile: string;
  };
  assert.notEqual(updated.profile, 'old profile');
  assert.match(updated.profile, /Lisbon|Porto|Tokyo/);
  closeDb(db);
});

test('detectArcs: clusters captured events that share entities; persists as kind=arc', () => {
  const db = freshDb();
  const now = new Date();
  const recentTs = (offsetMs: number) => new Date(now.getTime() - offsetMs).toISOString();

  // Three captures all referencing entities A and B → one arc
  const a = upsertEntity(db, 'topic', 'A');
  const b = upsertEntity(db, 'topic', 'B');
  const c = upsertEntity(db, 'topic', 'C');
  const e1 = insertCapture(db, recentTs(3 * 86400_000));
  const e2 = insertCapture(db, recentTs(2 * 86400_000));
  const e3 = insertCapture(db, recentTs(1 * 86400_000));
  addRelation(db, a.id, 'mentions', b.id, e1);
  addRelation(db, a.id, 'mentions', b.id, e2);
  addRelation(db, a.id, 'mentions', b.id, e3);

  // A standalone event referencing only C — should NOT join the A-B cluster
  const e4 = insertCapture(db, recentTs(4 * 3600_000));
  const d = upsertEntity(db, 'topic', 'D');
  addRelation(db, c.id, 'mentions', d.id, e4);

  const created = detectArcs(db, now);
  assert.equal(created, 1, `expected exactly 1 arc, got ${created}`);

  const arcs = db.prepare(`SELECT payload FROM events WHERE kind = 'arc'`).all() as Array<{
    payload: string;
  }>;
  assert.equal(arcs.length, 1);
  const payload = JSON.parse(arcs[0].payload);
  assert.ok(Array.isArray(payload.member_event_ids));
  assert.equal(payload.member_event_ids.length, 3);
  assert.deepEqual(
    [...payload.member_event_ids].sort((x, y) => x - y),
    [e1, e2, e3],
  );
  closeDb(db);
});

test('detectArcs: idempotent — re-running same day does not duplicate arcs', () => {
  const db = freshDb();
  const now = new Date();
  const a = upsertEntity(db, 'topic', 'A');
  const b = upsertEntity(db, 'topic', 'B');
  const e1 = insertCapture(db, new Date(now.getTime() - 2 * 86400_000).toISOString());
  const e2 = insertCapture(db, new Date(now.getTime() - 1 * 86400_000).toISOString());
  addRelation(db, a.id, 'mentions', b.id, e1);
  addRelation(db, a.id, 'mentions', b.id, e2);

  const c1 = detectArcs(db, now);
  const c2 = detectArcs(db, now);
  assert.equal(c1, 1);
  assert.equal(c2, 0);
  closeDb(db);
});

test('dream: journal is metrics-only and does NOT call the LLM even when one is available', async () => {
  // dream.run is now deterministic substrate maintenance: the journal it writes
  // is always the metrics block. The richer narrative is upserted later by the
  // 4:00am dream-synthesis pass over the same day key. Pass an LLM whose invoke
  // throws if reached — the journal must not depend on it.
  let invoked = false;
  const llm = mockLLM('this narrative must never appear in the journal');
  const orig = llm.invoke.bind(llm);
  llm.invoke = ((role, opts) => {
    // summarizeHotEntities + ingest-docs may legitimately call the LLM; only the
    // journal narrative is forbidden. With no hot entities / docs here, the only
    // call that COULD happen is the (now removed) journal narrative.
    invoked = true;
    return orig(role, opts);
  }) as typeof llm.invoke;

  const db = freshDb();
  await runDream(db, llm);
  const day = new Date().toISOString().slice(0, 10);
  const row = db.prepare(`SELECT body FROM journals WHERE day = ?`).get(day) as { body: string };
  assert.ok(row);
  // Metrics-only block: header + metric lines, no Narrative section, no LLM text.
  assert.match(row.body, /Robin Journal/);
  assert.match(row.body, /\*\*Captured:\*\*/);
  assert.match(row.body, /\*\*Arcs created:\*\*/);
  assert.doesNotMatch(row.body, /Narrative/);
  assert.doesNotMatch(row.body, /this narrative must never appear/);
  // No hot entities and no content docs in this fresh DB, so the journal change
  // means nothing in dream should have reached the LLM at all.
  assert.equal(invoked, false, 'dream journal must not invoke the LLM');
  closeDb(db);
});

test('dream: journal is metrics-only when LLM is null', async () => {
  const db = freshDb();
  const r = await runDream(db, null);
  assert.equal(r.entitiesSummarized, 0);
  const day = new Date().toISOString().slice(0, 10);
  const row = db.prepare(`SELECT body FROM journals WHERE day = ?`).get(day) as { body: string };
  assert.match(row.body, /Robin Journal/);
  assert.match(row.body, /\*\*Captured:\*\*/);
  assert.doesNotMatch(row.body, /Narrative/);
  closeDb(db);
});

test('dream: expires pending belief candidates older than 14 days', async () => {
  const db = freshDb();
  const fresh = insertBeliefCandidate(db, { topic: 'fresh', claim: 'recent claim' });
  const old = insertBeliefCandidate(db, { topic: 'stale', claim: 'old claim' });
  // Backdate the old candidate well past the 14-day window.
  db.prepare(`UPDATE belief_candidates SET created_at = '2020-01-01 00:00:00' WHERE id = ?`).run(
    old.id,
  );

  const r = await runDream(db, null);
  assert.equal(r.candidatesExpired, 1);

  const oldRow = db.prepare(`SELECT status FROM belief_candidates WHERE id = ?`).get(old.id) as {
    status: string;
  };
  const freshRow = db
    .prepare(`SELECT status FROM belief_candidates WHERE id = ?`)
    .get(fresh.id) as {
    status: string;
  };
  assert.equal(oldRow.status, 'rejected');
  assert.equal(freshRow.status, 'pending');
  closeDb(db);
});

test('dream: candidatesExpired is 0 (no crash) when belief_candidates table is missing', async () => {
  const db = freshDb();
  db.exec(`DROP TABLE belief_candidates`);
  const r = await runDream(db, null);
  assert.equal(r.candidatesExpired, 0);
  // The rest of dream still ran.
  assert.equal(r.journalGenerated, true);
  closeDb(db);
});

test('dream: staleFlagsRaised is 0 when content/profile dir is missing', async () => {
  const { db, teardown } = freshDbWithUserDataDir();
  // No content/profile dir created.
  believe(db, null, { topic: 'google-role', claim: 'Ad Experiences' });
  const r = await runDream(db, null);
  assert.equal(r.staleFlagsRaised, 0);
  teardown();
});

test('dream: flags a prose doc older than the newest belief signal', async () => {
  const { db, dir, teardown } = freshDbWithUserDataDir();
  // Doc mtime in the past; a belief is written "now" (newer), so it is stale.
  writeProfileDoc(dir, 'character.md', '# Character', Date.now() - 7 * 86_400_000);
  believe(db, null, { topic: 'google-role', claim: 'Ad Experiences' });

  const r = await runDream(db, null);
  assert.equal(r.staleFlagsRaised, 1);

  const flag = db.prepare(`SELECT payload FROM events WHERE kind = 'narrative.stale'`).get() as {
    payload: string;
  };
  const payload = JSON.parse(flag.payload);
  assert.equal(payload.doc, 'character.md');
  assert.equal(payload.reason, 'beliefs/corrections updated after doc');
  assert.ok(payload.newest_signal_ts);
  assert.ok(payload.doc_mtime);
  teardown();
});

test('dream: does NOT flag a prose doc newer than all belief/correction signals', async () => {
  const { db, dir, teardown } = freshDbWithUserDataDir();
  believe(db, null, { topic: 'google-role', claim: 'Ad Experiences' });
  // Doc mtime well in the future — newer than the just-written belief.
  writeProfileDoc(dir, 'character.md', '# Character', Date.now() + 86_400_000);

  const r = await runDream(db, null);
  assert.equal(r.staleFlagsRaised, 0);
  teardown();
});

test('dream: also flags against newer corrections, not just beliefs', async () => {
  const { db, dir, teardown } = freshDbWithUserDataDir();
  writeProfileDoc(dir, 'voice.md', '# Voice', Date.now() - 7 * 86_400_000);
  db.prepare(`INSERT INTO corrections (what, correction) VALUES (?, ?)`).run(
    'tone',
    'be more concise',
  );

  const r = await runDream(db, null);
  assert.equal(r.staleFlagsRaised, 1);
  const flag = db.prepare(`SELECT payload FROM events WHERE kind = 'narrative.stale'`).get() as {
    payload: string;
  };
  assert.equal(JSON.parse(flag.payload).doc, 'voice.md');
  teardown();
});

test('dream: does not re-flag the same doc twice the same day (dedup)', async () => {
  const { db, dir, teardown } = freshDbWithUserDataDir();
  writeProfileDoc(dir, 'character.md', '# Character', Date.now() - 7 * 86_400_000);
  believe(db, null, { topic: 'google-role', claim: 'Ad Experiences' });

  const now = new Date();
  const r1 = await runDream(db, null, now);
  const r2 = await runDream(db, null, now);
  assert.equal(r1.staleFlagsRaised, 1);
  assert.equal(r2.staleFlagsRaised, 0);

  const count = (
    db.prepare(`SELECT COUNT(*) AS c FROM events WHERE kind = 'narrative.stale'`).get() as {
      c: number;
    }
  ).c;
  assert.equal(count, 1);
  teardown();
});

test('dream: raises 0 stale flags when no beliefs or corrections exist', async () => {
  const { db, dir, teardown } = freshDbWithUserDataDir();
  writeProfileDoc(dir, 'character.md', '# Character', Date.now() - 7 * 86_400_000);
  const r = await runDream(db, null);
  assert.equal(r.staleFlagsRaised, 0);
  teardown();
});

// ── Belief lifecycle pass tests ──────────────────────────────────────────────

test('promoteStableCandidates: promotes old non-contradicted candidates', () => {
  const db = freshDb();
  const now = new Date();
  // Backdate to 10 days ago (past 7-day promote threshold but within 14-day expiry).
  const tenDaysAgo = new Date(now.getTime() - 10 * 86_400_000)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');
  const c = insertBeliefCandidate(db, {
    topic: 'fav-color',
    claim: 'Kevin likes blue',
    confidence: 0.9,
    provenance: 'first-party',
  });
  db.prepare(`UPDATE belief_candidates SET created_at = ? WHERE id = ?`).run(tenDaysAgo, c.id);

  const res = promoteStableCandidates(db, now);
  assert.equal(res.promoted, 1);
  assert.equal(res.conflicted, 0);
  assert.equal(res.merged, 0);

  const row = db.prepare(`SELECT status FROM belief_candidates WHERE id = ?`).get(c.id) as {
    status: string;
  };
  assert.equal(row.status, 'promoted');
  closeDb(db);
});

test('promoteStableCandidates: leaves young candidates untouched', () => {
  const db = freshDb();
  // Insert a candidate created just now (within 7-day window).
  insertBeliefCandidate(db, {
    topic: 'fav-color',
    claim: 'Kevin likes green',
    confidence: 0.9,
    provenance: 'first-party',
  });

  const res = promoteStableCandidates(db, new Date());
  assert.equal(res.promoted, 0);
  assert.equal(res.conflicted, 0);
  assert.equal(res.merged, 0);
  closeDb(db);
});

test('promoteStableCandidates: flags contradicted candidates', () => {
  const db = freshDb();
  const now = new Date();
  const tenDaysAgo = new Date(now.getTime() - 10 * 86_400_000)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');
  // Write an existing belief head with a different claim.
  believe(db, null, { topic: 'fav-color', claim: 'Kevin likes red' });

  // Insert a contradicting candidate and backdate it.
  const c = insertBeliefCandidate(db, {
    topic: 'fav-color',
    claim: 'Kevin likes blue',
    confidence: 0.9,
    provenance: 'first-party',
  });
  db.prepare(`UPDATE belief_candidates SET created_at = ? WHERE id = ?`).run(tenDaysAgo, c.id);

  const res = promoteStableCandidates(db, now);
  assert.equal(res.promoted, 0);
  assert.equal(res.conflicted, 1);

  const row = db.prepare(`SELECT status FROM belief_candidates WHERE id = ?`).get(c.id) as {
    status: string;
  };
  assert.equal(row.status, 'conflicted');
  closeDb(db);
});

test('promoteStableCandidates: folds a same-fact rephrasing of the head into merged', () => {
  const db = freshDb();
  const now = new Date();
  const tenDaysAgo = new Date(now.getTime() - 10 * 86_400_000)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');
  // Head holds the fact with extra detail; candidate restates a subset of it.
  believe(db, null, {
    topic: 'brother-name',
    claim: "Kevin's brother is Jake Lee, also known as Joony",
  });
  const c = insertBeliefCandidate(db, {
    topic: 'brother-name',
    claim: "Kevin's brother is Jake Lee",
    confidence: 0.9,
    provenance: 'first-party',
  });
  db.prepare(`UPDATE belief_candidates SET created_at = ? WHERE id = ?`).run(tenDaysAgo, c.id);

  const res = promoteStableCandidates(db, now);
  // Rephrasing → merged into head, NOT flagged as a conflict, NOT promoted.
  assert.equal(res.conflicted, 0);
  assert.equal(res.promoted, 0);
  assert.equal(res.merged, 1);
  const row = db.prepare(`SELECT status FROM belief_candidates WHERE id = ?`).get(c.id) as {
    status: string;
  };
  assert.equal(row.status, 'merged');
  closeDb(db);
});

test('promoteStableCandidates: a negation flip stays conflicted, never merged', () => {
  const db = freshDb();
  const now = new Date();
  const tenDaysAgo = new Date(now.getTime() - 10 * 86_400_000)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');
  believe(db, null, { topic: 'lens-x-ownership', claim: 'Kevin owns the Nikon Z 100-400 lens' });
  const c = insertBeliefCandidate(db, {
    topic: 'lens-x-ownership',
    claim: 'Kevin does not own the Nikon Z 100-400 lens',
    confidence: 0.9,
    provenance: 'first-party',
  });
  db.prepare(`UPDATE belief_candidates SET created_at = ? WHERE id = ?`).run(tenDaysAgo, c.id);

  const res = promoteStableCandidates(db, now);
  assert.equal(res.merged, 0);
  assert.equal(res.conflicted, 1);
  closeDb(db);
});

test('promoteStableCandidates: merges near-duplicate candidates', () => {
  const db = freshDb();
  const now = new Date();
  const tenDaysAgo = new Date(now.getTime() - 10 * 86_400_000)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');
  // Two near-duplicate claims on the same topic.
  const c1 = insertBeliefCandidate(db, {
    topic: 'fav-food',
    claim: 'Kevin likes pasta a lot',
    confidence: 0.8,
    provenance: 'first-party',
  });
  const c2 = insertBeliefCandidate(db, {
    topic: 'fav-food',
    claim: 'Kevin likes pasta alot',
    confidence: 0.7,
    provenance: 'first-party',
  });
  // Backdate both past 7 days.
  db.prepare(`UPDATE belief_candidates SET created_at = ? WHERE id IN (?, ?)`).run(
    tenDaysAgo,
    c1.id,
    c2.id,
  );

  const res = promoteStableCandidates(db, now);
  assert.equal(res.merged, 1);
  // The higher-confidence one (c1) should survive and be promoted.
  const r1 = db.prepare(`SELECT status FROM belief_candidates WHERE id = ?`).get(c1.id) as {
    status: string;
  };
  const r2 = db.prepare(`SELECT status FROM belief_candidates WHERE id = ?`).get(c2.id) as {
    status: string;
  };
  assert.equal(r2.status, 'merged');
  assert.equal(r1.status, 'promoted');
  closeDb(db);
});

test('promoteStableCandidates: gate-blocked candidates counted separately', () => {
  const db = freshDb();
  const now = new Date();
  const tenDaysAgo = new Date(now.getTime() - 10 * 86_400_000)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');
  // Insert a candidate with external provenance — P3 gate will block it.
  const c = insertBeliefCandidate(db, {
    topic: 'ext-data',
    claim: 'Some external reading',
    confidence: 0.95,
    provenance: 'external',
  });
  db.prepare(`UPDATE belief_candidates SET created_at = ? WHERE id = ?`).run(tenDaysAgo, c.id);

  const res = promoteStableCandidates(db, now);
  assert.equal(res.promoted, 0);
  assert.equal(res.gateBlocked, 1);
  closeDb(db);
});

test('dream: full lifecycle — 5 candidates with various ages/topics/claims', async () => {
  const db = freshDb();
  const now = new Date();
  // 10 days ago: past 7-day promote threshold but within 14-day expiry.
  const tenDaysAgo = new Date(now.getTime() - 10 * 86_400_000)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');

  // 1. Old, no conflict, should promote
  const c1 = insertBeliefCandidate(db, {
    topic: 'hobby',
    claim: 'Kevin plays guitar',
    confidence: 0.9,
    provenance: 'first-party',
  });
  db.prepare(`UPDATE belief_candidates SET created_at = ? WHERE id = ?`).run(tenDaysAgo, c1.id);

  // 2. Old, contradicts existing belief head
  believe(db, null, { topic: 'job-title', claim: 'Software Engineer' });
  const c2 = insertBeliefCandidate(db, {
    topic: 'job-title',
    claim: 'Data Scientist',
    confidence: 0.9,
    provenance: 'first-party',
  });
  db.prepare(`UPDATE belief_candidates SET created_at = ? WHERE id = ?`).run(tenDaysAgo, c2.id);

  // 3+4. Old near-duplicates — should merge
  const c3 = insertBeliefCandidate(db, {
    topic: 'pet',
    claim: 'Kevin has a dog named Max',
    confidence: 0.85,
    provenance: 'first-party',
  });
  const c4 = insertBeliefCandidate(db, {
    topic: 'pet',
    claim: 'Kevin has a dog named Mex',
    confidence: 0.7,
    provenance: 'first-party',
  });
  db.prepare(`UPDATE belief_candidates SET created_at = ? WHERE id IN (?, ?)`).run(
    tenDaysAgo,
    c3.id,
    c4.id,
  );

  // 5. Young, should be untouched
  const c5 = insertBeliefCandidate(db, {
    topic: 'city',
    claim: 'Kevin lives in NYC',
    confidence: 0.9,
    provenance: 'first-party',
  });

  const r = await runDream(db, null, now);
  assert.ok(r.candidatesPromoted >= 1, `expected >=1 promoted, got ${r.candidatesPromoted}`);
  assert.ok(r.candidatesConflicted >= 1, `expected >=1 conflicted, got ${r.candidatesConflicted}`);
  assert.ok(r.candidatesMerged >= 1, `expected >=1 merged, got ${r.candidatesMerged}`);

  // c5 should still be pending.
  const r5 = db.prepare(`SELECT status FROM belief_candidates WHERE id = ?`).get(c5.id) as {
    status: string;
  };
  assert.equal(r5.status, 'pending');
  closeDb(db);
});

// ── Depth synthesis query tests ──────────────────────────────────────────────

test('queryDecisionReplays: returns topics with >1 belief revisions', () => {
  const db = freshDb();
  // Write two belief updates on the same topic on different dates
  // (same-day believe() uses upsert via external_id).
  believe(db, null, { topic: 'role', claim: 'Engineer', date: '2026-05-20' });
  believe(db, null, { topic: 'role', claim: 'Senior Engineer', date: '2026-05-21' });

  const replays = queryDecisionReplays(db, 30);
  assert.ok(replays.length >= 1);
  assert.equal(replays[0].topic, 'role');
  assert.ok(replays[0].revisions >= 2);
  closeDb(db);
});

test('queryDecisionReplays: excludes topics with only 1 revision', () => {
  const db = freshDb();
  believe(db, null, { topic: 'unique-topic', claim: 'Only stated once' });

  const replays = queryDecisionReplays(db, 30);
  const found = replays.find((r) => r.topic === 'unique-topic');
  assert.equal(found, undefined);
  closeDb(db);
});

test('queryDecisionReplays: retracted canonicalize tombstones are not counted as revisions', () => {
  const db = freshDb();
  // Two live revisions on 'role' → should appear in replays.
  believe(db, null, { topic: 'role', claim: 'Engineer', date: '2026-05-20' });
  believe(db, null, { topic: 'role', claim: 'Senior Engineer', date: '2026-05-21' });

  // 'no-aerospace-internship': one live write + one retraction tombstone (simulates
  // canonicalize-heads sweep). Only 1 live event; should NOT appear in replays.
  ingest(db, null, {
    kind: 'belief.update',
    source: 'belief',
    content: 'Kevin has an aerospace internship',
    payload: {
      topic: 'no-aerospace-internship',
      supersedes: null,
      confidence: null,
      sources: [],
      retracted: false,
      provenance: 'unknown',
      verified_at: new Date().toISOString(),
      external_id: 'belief:2026-05-20:no-aerospace-internship',
    },
  });
  // Retraction tombstone — must not count as a revision.
  ingest(db, null, {
    kind: 'belief.update',
    source: 'belief',
    content: 'Kevin has an aerospace internship',
    payload: {
      topic: 'no-aerospace-internship',
      supersedes: null,
      confidence: null,
      sources: [],
      retracted: true,
      provenance: 'unknown',
      verified_at: new Date().toISOString(),
      external_id: 'canonicalize:no-aerospace-internship:99',
    },
  });

  const replays = queryDecisionReplays(db, 30);
  // 'role' has 2 live revisions — should appear.
  const roleReplay = replays.find((r) => r.topic === 'role');
  assert.ok(roleReplay, 'role with 2 live revisions should appear in replays');
  assert.ok(roleReplay!.revisions >= 2);
  // 'no-aerospace-internship' has only 1 live + 1 retracted — should NOT appear.
  const aeroReplay = replays.find((r) => r.topic === 'no-aerospace-internship');
  assert.equal(aeroReplay, undefined, 'topic with retraction tombstone must not appear in replays');
  closeDb(db);
});

test('queryPredictionCalibration: groups resolved predictions by outcome', () => {
  const db = freshDb();
  // Insert resolved predictions.
  db.prepare(
    `INSERT INTO predictions (claim, confidence, outcome, resolved_at, brier_delta) VALUES (?, ?, ?, ?, ?)`,
  ).run('it will rain', 0.8, 'right', new Date().toISOString(), 0.04);
  db.prepare(
    `INSERT INTO predictions (claim, confidence, outcome, resolved_at, brier_delta) VALUES (?, ?, ?, ?, ?)`,
  ).run('market up', 0.6, 'wrong', new Date().toISOString(), 0.36);

  const cal = queryPredictionCalibration(db);
  assert.ok(cal.length >= 2);
  const right = cal.find((c) => c.outcome === 'right');
  const wrong = cal.find((c) => c.outcome === 'wrong');
  assert.ok(right);
  assert.equal(right!.count, 1);
  assert.ok(wrong);
  assert.equal(wrong!.count, 1);
  closeDb(db);
});

test('queryApproachingDeadlines: returns predictions due within 7 days', () => {
  const db = freshDb();
  const now = new Date();
  const in3days = new Date(now.getTime() + 3 * 86_400_000).toISOString();
  const in10days = new Date(now.getTime() + 10 * 86_400_000).toISOString();

  db.prepare(`INSERT INTO predictions (claim, confidence, deadline) VALUES (?, ?, ?)`).run(
    'close deadline',
    0.7,
    in3days,
  );
  db.prepare(`INSERT INTO predictions (claim, confidence, deadline) VALUES (?, ?, ?)`).run(
    'far deadline',
    0.5,
    in10days,
  );

  const deadlines = queryApproachingDeadlines(db, now);
  assert.equal(deadlines.length, 1);
  assert.equal(deadlines[0].type, 'prediction');
  assert.equal(deadlines[0].label, 'close deadline');
  closeDb(db);
});

test('queryApproachingDeadlines: includes Linear issues with due dates', () => {
  const db = freshDb();
  const now = new Date();
  const in2days = new Date(now.getTime() + 2 * 86_400_000).toISOString().slice(0, 10);

  db.prepare(
    `INSERT INTO events (ts, kind, source, status, payload) VALUES (?, 'integration.linear.issue', 'linear', 'ok', ?)`,
  ).run(
    now.toISOString(),
    JSON.stringify({ identifier: 'KL-10', title: 'Fix auth flow', dueDate: in2days }),
  );

  const deadlines = queryApproachingDeadlines(db, now);
  const linear = deadlines.find((d) => d.type === 'linear');
  assert.ok(linear, 'expected a linear deadline');
  assert.match(linear!.label, /KL-10/);
  closeDb(db);
});

// ── Journal depth sections tests ─────────────────────────────────────────────

test('dream: journal includes depth sections when data exists', async () => {
  const db = freshDb();
  const now = new Date();

  // Create belief revisions on different dates to trigger decision replays.
  believe(db, null, { topic: 'role', claim: 'Engineer', date: '2026-05-20' });
  believe(db, null, { topic: 'role', claim: 'Senior Engineer', date: '2026-05-21' });

  // Create a resolved prediction for calibration.
  db.prepare(
    `INSERT INTO predictions (claim, confidence, outcome, resolved_at, brier_delta) VALUES (?, ?, ?, ?, ?)`,
  ).run('it will rain', 0.8, 'right', now.toISOString(), 0.04);

  // Create a prediction with approaching deadline.
  const in3days = new Date(now.getTime() + 3 * 86_400_000).toISOString();
  db.prepare(`INSERT INTO predictions (claim, confidence, deadline) VALUES (?, ?, ?)`).run(
    'market up',
    0.6,
    in3days,
  );

  const r = await runDream(db, null, now);
  assert.ok(
    r.depthInsightsGenerated >= 2,
    `expected >=2 depth sections, got ${r.depthInsightsGenerated}`,
  );

  const day = now.toISOString().slice(0, 10);
  const journal = db.prepare(`SELECT body FROM journals WHERE day = ?`).get(day) as {
    body: string;
  };
  assert.match(journal.body, /Decision replays/);
  assert.match(journal.body, /Prediction calibration/);
  assert.match(journal.body, /Approaching deadlines/);
  closeDb(db);
});

test('dream: journal has no depth sections when no depth data', async () => {
  const db = freshDb();
  const r = await runDream(db, null);
  assert.equal(r.depthInsightsGenerated, 0);

  const day = new Date().toISOString().slice(0, 10);
  const journal = db.prepare(`SELECT body FROM journals WHERE day = ?`).get(day) as {
    body: string;
  };
  assert.doesNotMatch(journal.body, /Decision replays/);
  assert.doesNotMatch(journal.body, /Prediction calibration/);
  assert.doesNotMatch(journal.body, /Approaching deadlines/);
  closeDb(db);
});

// ── Learning digest tests ──────────────────────────────────────────────────

function baseDreamResult(): DreamResult {
  return {
    predictionsResolved: 0,
    brierDeltaSum: 0,
    journalGenerated: false,
    entitiesSummarized: 0,
    arcsCreated: 0,
    candidatesExpired: 1,
    candidatesDeduped: 0,
    staleFlagsRaised: 0,
    staleBeliefsFlagged: 0,
    beliefsRefreshed: 0,
    claimsRetried: 0,
    claimsRecovered: 0,
    docsIngested: 0,
    correctionsApplied: 0,
    beliefsRetracted: 0,
    candidatesPromoted: 2,
    candidatesConflicted: 1,
    candidatesMerged: 0,
    depthInsightsGenerated: 0,
    digestGenerated: false,
    hygieneRelationsDeleted: 0,
    hygieneEntitiesDeleted: 0,
    hygieneEntitiesAutoCulled: 0,
    hygieneBlocklistGrown: 0,
  };
}

function seedDigestDb(db: ReturnType<typeof freshDb>) {
  const now = new Date();
  const recentTs = new Date(now.getTime() - 3600_000).toISOString();

  // 3 agent_usage rows: 1 success, 1 capped, 1 error
  db.prepare(
    `INSERT INTO agent_usage (ts, surface, label, input_tokens, output_tokens, cost_usd, turns, status)
     VALUES (?, 'autonomous', 'biographer', 100, 50, 1.50, 5, 'success')`,
  ).run(recentTs);
  db.prepare(
    `INSERT INTO agent_usage (ts, surface, label, input_tokens, output_tokens, cost_usd, turns, status)
     VALUES (?, 'autonomous', 'dream-synthesis', 200, 100, 3.00, 10, 'capped')`,
  ).run(recentTs);
  db.prepare(
    `INSERT INTO agent_usage (ts, surface, label, input_tokens, output_tokens, cost_usd, turns, status)
     VALUES (?, 'on-demand', 'user-query', 50, 25, 0.50, 3, 'error')`,
  ).run(recentTs);

  // 3 predictions: 1 right, 1 wrong, 1 open with deadline
  db.prepare(
    `INSERT INTO predictions (claim, confidence, outcome, resolved_at, brier_delta)
     VALUES ('it will rain', 0.8, 'right', ?, 0.04)`,
  ).run(now.toISOString());
  db.prepare(
    `INSERT INTO predictions (claim, confidence, outcome, resolved_at, brier_delta)
     VALUES ('market up', 0.6, 'wrong', ?, 0.36)`,
  ).run(now.toISOString());
  const in3days = new Date(now.getTime() + 3 * 86_400_000).toISOString();
  db.prepare(
    `INSERT INTO predictions (claim, confidence, deadline) VALUES ('new feature ships', 0.7, ?)`,
  ).run(in3days);

  // 5 corrections: all NULL topic (behavioral)
  for (let i = 0; i < 5; i++) {
    db.prepare(`INSERT INTO corrections (what, correction) VALUES (?, ?)`).run(
      `mistake ${i}`,
      `rule ${i}`,
    );
  }

  return { now, in3days };
}

test('composeLearningDigest: returns correct structured object', () => {
  const db = freshDb();
  const { now } = seedDigestDb(db);
  const result = baseDreamResult();
  const digest = composeLearningDigest(db, result, now);

  // Handler activity
  assert.ok(digest.handlerActivity.length >= 1);
  const autonomous = digest.handlerActivity.find((h) => h.surface === 'autonomous');
  assert.ok(autonomous);
  assert.equal(autonomous!.runs, 2);

  // Predictions
  assert.ok(digest.predictionsByOutcome.length >= 2);
  const right = digest.predictionsByOutcome.find((p) => p.outcome === 'right');
  assert.ok(right);
  assert.equal(right!.n, 1);

  // Overall Brier
  assert.ok(digest.overallBrier != null);
  assert.ok(digest.overallBrier! > 0);

  // Open predictions
  assert.equal(digest.openPredictions.count, 1);
  assert.ok(digest.openPredictions.nearestDeadline);

  // Belief lifecycle from DreamResult
  assert.equal(digest.beliefLifecycle.promoted, 2);
  assert.equal(digest.beliefLifecycle.conflicted, 1);
  assert.equal(digest.beliefLifecycle.expired, 1);

  // Corrections
  assert.equal(digest.corrections.total, 5);
  assert.equal(digest.corrections.behavioral, 5);
  assert.equal(digest.corrections.topicLinked, 0);

  // Failed runs
  assert.ok(digest.failedRuns.length >= 2); // capped + error
  closeDb(db);
});

test('composeLearningDigest: persists a dream.learning_digest event', () => {
  const db = freshDb();
  const { now } = seedDigestDb(db);
  const result = baseDreamResult();
  composeLearningDigest(db, result, now);

  const row = db
    .prepare(`SELECT payload FROM events WHERE kind = 'dream.learning_digest'`)
    .get() as { payload: string };
  assert.ok(row);
  const parsed = JSON.parse(row.payload);
  assert.ok(parsed.digest);
  assert.ok(parsed.external_id.startsWith('learning-digest:'));
  closeDb(db);
});

test('composeLearningDigest: idempotent — re-running same day does not duplicate', () => {
  const db = freshDb();
  const { now } = seedDigestDb(db);
  const result = baseDreamResult();
  composeLearningDigest(db, result, now);
  composeLearningDigest(db, result, now);

  const count = (
    db.prepare(`SELECT COUNT(*) AS c FROM events WHERE kind = 'dream.learning_digest'`).get() as {
      c: number;
    }
  ).c;
  assert.equal(count, 1);
  closeDb(db);
});

test('runDream: sets digestGenerated=true and persists digest event', async () => {
  const db = freshDb();
  const now = new Date();
  seedDigestDb(db);
  const r = await runDream(db, null, now);
  assert.equal(r.digestGenerated, true);

  const row = db.prepare(`SELECT payload FROM events WHERE kind = 'dream.learning_digest'`).get() as
    | { payload: string }
    | undefined;
  assert.ok(row, 'digest event should exist after runDream');
  closeDb(db);
});

test('latestLearningDigest: returns rendered text after digest is persisted', () => {
  const db = freshDb();
  const { now } = seedDigestDb(db);
  const result = baseDreamResult();
  composeLearningDigest(db, result, now);

  const text = latestLearningDigest(db);
  assert.ok(text);
  assert.match(text, /Predictions/);
  assert.match(text, /Beliefs/);
  assert.match(text, /Corrections/);
  closeDb(db);
});

test('latestLearningDigest: returns null when no digest exists', () => {
  const db = freshDb();
  const text = latestLearningDigest(db);
  assert.equal(text, null);
  closeDb(db);
});

test('renderLearningDigest: formats digest into compact bullet list', () => {
  const digest: LearningDigest = {
    handlerActivity: [
      {
        surface: 'autonomous',
        runs: 16,
        cost: 16.64,
        turns: 80,
        handlers: 'biographer,dream-synthesis',
      },
      { surface: 'on-demand', runs: 3, cost: 10.21, turns: 15, handlers: 'user-query' },
    ],
    predictionsByOutcome: [
      { outcome: 'right', n: 2 },
      { outcome: 'wrong', n: 1 },
      { outcome: 'unverifiable', n: 4 },
    ],
    overallBrier: 0.23,
    openPredictions: { count: 5, nearestDeadline: '2026-05-27T00:00:00.000Z' },
    beliefLifecycle: {
      promoted: 3,
      conflicted: 1,
      merged: 0,
      expired: 2,
      pendingCandidates: 2330,
      activeBeliefHeads: 45,
    },
    corrections: { total: 16, behavioral: 16, topicLinked: 0, unapplied: 0 },
    failedRuns: [
      { surface: 'autonomous', label: 'biographer', status: 'capped', ts: '2026-05-25T03:00:00Z' },
      {
        surface: 'autonomous',
        label: 'dream-synthesis',
        status: 'capped',
        ts: '2026-05-25T04:00:00Z',
      },
    ],
  };

  const text = renderLearningDigest(digest);
  assert.match(text, /2 right/);
  assert.match(text, /1 wrong/);
  assert.match(text, /4 unverifiable/);
  assert.match(text, /Brier: 0\.23/);
  assert.match(text, /5 open predictions/);
  assert.match(text, /nearest deadline: 2026-05-27/);
  assert.match(text, /3 promoted/);
  assert.match(text, /1 conflicted/);
  assert.match(text, /2330 candidates pending/);
  assert.match(text, /16 autonomous/);
  assert.match(text, /3 on-demand/);
  assert.match(text, /2 failed/);
  assert.match(text, /16 total/);
  assert.match(text, /16 behavioral/);
});

// ─── nightly claim dead-letter retry (§C3) ──────────────────────────────────────
// The retry pass moved out of the every-minute biographer tick into the nightly
// dream pass so a transient outage can't exhaust attempts the same hour. This
// asserts runDream drains a seeded dead letter via the claim-extraction prompt.

/**
 * Dispatcher that answers the claim-extraction prompt with `claimsJson` and
 * everything else (entity pass, embeds, freshness probes) with `[]`, so the only
 * sub-pass it materially drives is the dead-letter retry.
 */
function claimsLLM(claimsJson: string): LLMDispatcher {
  const p: LLMProvider = {
    name: 'claims-only',
    capabilities: new Set(['summarize', 'reasoning']),
    meta: { contextWindow: 8000, inputPricePerM: 0, outputPricePerM: 0 },
    invoke: async (req) => ({
      text: (req.systemPrompt ?? '').includes('DURABLE PERSONAL FACTS') ? claimsJson : '[]',
      usage: { inputTokens: 0, outputTokens: 0 },
      costUsd: 0,
      latencyMs: 0,
      provider: 'claims-only',
    }),
  };
  const d = new LLMDispatcher();
  d.register('p', p);
  d.assign('summarize', 'p');
  d.assign('reasoning', 'p');
  return d;
}

test('dream: nightly pass drains a seeded claim dead letter', async () => {
  const db = freshDb();
  // A real source event so the retry's provenance recompute has a kind to classify.
  const eventId = insertCapture(db, new Date().toISOString());
  db.prepare(
    `INSERT INTO claim_failures (event_id, chunk_idx, chunk_body, attempts, last_error, ts)
     VALUES (?, 0, ?, 1, 'json parse: seeded', datetime('now'))`,
  ).run(eventId, '[USER]\nmy primary camera is a Nikon Z8');

  const llm = claimsLLM(
    JSON.stringify({
      claims: [{ topic: 'primary-camera', claim: 'Nikon Z8', confidence: 0.9, domain: 'creative' }],
    }),
  );
  const r = await runDream(db, llm);

  // The dream result surfaces the retry counts, the way the freshness sub-pass does.
  assert.equal(r.claimsRetried, 1, 'one open dead letter re-attempted');
  assert.equal(r.claimsRecovered, 1, 'the clean re-extraction recovered the row');

  // Row cleared; the recovered claim entered the candidate queue.
  const remaining = db.prepare(`SELECT COUNT(*) AS c FROM claim_failures`).get() as { c: number };
  assert.equal(remaining.c, 0, 'recovered dead letter is deleted');
  const cand = db.prepare(`SELECT topic FROM belief_candidates WHERE status = 'pending'`).get() as
    | { topic: string }
    | undefined;
  assert.ok(cand, 'recovered claim entered the candidate queue');
  assert.equal(cand.topic, 'primary-camera');
  closeDb(db);
});

test('dream: claim retry is skipped (no crash) when llm is null', async () => {
  const db = freshDb();
  const eventId = insertCapture(db, new Date().toISOString());
  db.prepare(
    `INSERT INTO claim_failures (event_id, chunk_idx, chunk_body, attempts, last_error, ts)
     VALUES (?, 0, ?, 1, 'json parse: seeded', datetime('now'))`,
  ).run(eventId, '[USER]\nmy primary camera is a Nikon Z8');

  const r = await runDream(db, null);
  assert.equal(r.claimsRetried, 0, 'no retry without an LLM');
  assert.equal(r.claimsRecovered, 0);
  const remaining = db.prepare(`SELECT COUNT(*) AS c FROM claim_failures`).get() as { c: number };
  assert.equal(remaining.c, 1, 'the dead letter is left untouched');
  closeDb(db);
});

test('dream: domainGating:false flag reaches retryClaimFailures — non-personal claim is recovered', async () => {
  // Mirrors 'dream: nightly pass drains a seeded claim dead letter' but with
  // domainGating:false so a claim tagged with a non-personal domain (engineering)
  // is recovered into the candidate queue. With gating ON (default), the same
  // claim would be dropped (no candidate row) even though the dead-letter row
  // still clears. This test proves the flag travels from runDream opts all the
  // way into retryClaimFailures.
  const db = freshDb();
  const eventId = insertCapture(db, new Date().toISOString());
  db.prepare(
    `INSERT INTO claim_failures (event_id, chunk_idx, chunk_body, attempts, last_error, ts)
     VALUES (?, 0, ?, 1, 'json parse: seeded', datetime('now'))`,
  ).run(eventId, '[USER]\nbuild pipeline runs in parallel');

  // LLM returns a claim tagged domain=engineering (non-personal → dropped when gating=on).
  const llm = claimsLLM(
    JSON.stringify({
      claims: [
        {
          topic: 'build-pipeline',
          claim: 'Build pipeline runs in parallel',
          confidence: 0.8,
          domain: 'engineering',
        },
      ],
    }),
  );

  const r = await runDream(db, llm, undefined, { domainGating: false });

  // With gating OFF the non-personal claim must land in the candidate queue.
  assert.equal(r.claimsRetried, 1, 'one open dead letter re-attempted');
  assert.equal(r.claimsRecovered, 1, 'non-personal claim recovered when gating is off');

  const remaining = db.prepare(`SELECT COUNT(*) AS c FROM claim_failures`).get() as { c: number };
  assert.equal(remaining.c, 0, 'dead letter cleared');

  const cand = db
    .prepare(`SELECT topic FROM belief_candidates WHERE status = 'pending'`)
    .get() as { topic: string } | undefined;
  assert.ok(cand, 'non-personal claim entered the candidate queue (gating off)');
  assert.equal(cand.topic, 'build-pipeline');
  closeDb(db);
});

// ── profile_generated_at stale-fill (Task 9) ──────────────────────────────────

test('summarizeHotEntities: entity with 40-day-old profile + recent relations is re-summarized when no hot entities', async () => {
  const db = freshDb();

  // Create an entity with a profile that is 40 days stale.
  const ent = upsertEntity(db, 'person', 'Eve', 'old stale profile text');
  db.prepare(
    `UPDATE entities SET profile_generated_at = datetime('now', '-40 days') WHERE id = ?`,
  ).run(ent.id);

  // Add a recent relation (within last 7 days) — using two other entities so there's a join target.
  const place = upsertEntity(db, 'place', 'Berlin');
  db.prepare(
    `INSERT INTO relations (subject_id, predicate, object_id, ts, source_event_id) VALUES (?, 'visited', ?, datetime('now', '-1 day'), NULL)`,
  ).run(ent.id, place.id);

  // No entities have >= ENTITY_SUMMARY_MIN_SIGNALS (3) new signals today, so hot = [].
  const llm = mockLLM('Eve recently visited Berlin and has an updated profile.');
  // since = 1 hour ago so the newly added relation is NOT in the hot window.
  const since = new Date(Date.now() - 3600 * 1000).toISOString();
  const count = await summarizeHotEntities(db, llm, since);

  assert.ok(count >= 1, `expected >=1 re-summarized stale entity, got ${count}`);

  const updated = db
    .prepare('SELECT profile, profile_generated_at FROM entities WHERE id = ?')
    .get(ent.id) as {
    profile: string;
    profile_generated_at: string | null;
  };
  assert.notEqual(updated.profile, 'old stale profile text', 'stale profile should be replaced');
  assert.ok(
    updated.profile_generated_at !== null,
    'profile_generated_at should be set after re-summarize',
  );

  // profile_generated_at should be recent (not the 40-day-old backdate).
  const cmp = db
    .prepare(`SELECT datetime(?) >= datetime('now', '-5 seconds') AS ok`)
    .get(updated.profile_generated_at) as { ok: number };
  assert.equal(
    cmp.ok,
    1,
    `profile_generated_at (${updated.profile_generated_at}) should be refreshed`,
  );

  closeDb(db);
});

test('summarizeHotEntities: stale entity without recent relations is NOT included in fill', async () => {
  const db = freshDb();

  // Create an entity with a stale profile but NO recent relations.
  const ent = upsertEntity(db, 'person', 'Frank', 'old stale profile no recent relations');
  db.prepare(
    `UPDATE entities SET profile_generated_at = datetime('now', '-40 days') WHERE id = ?`,
  ).run(ent.id);
  // Add an OLD relation (older than 7 days).
  const place = upsertEntity(db, 'place', 'Oslo');
  db.prepare(
    `INSERT INTO relations (subject_id, predicate, object_id, ts, source_event_id) VALUES (?, 'visited', ?, datetime('now', '-10 days'), NULL)`,
  ).run(ent.id, place.id);

  const llm = mockLLM('Frank updated profile.');
  const since = new Date(Date.now() - 3600 * 1000).toISOString();
  const count = await summarizeHotEntities(db, llm, since);

  assert.equal(count, 0, 'entity with no recent relations should not be picked up by stale-fill');

  const row = db.prepare('SELECT profile FROM entities WHERE id = ?').get(ent.id) as {
    profile: string;
  };
  assert.equal(row.profile, 'old stale profile no recent relations', 'profile should be unchanged');
  closeDb(db);
});

test('summarizeHotEntities: stamps profile_generated_at after hot-entity profile write', async () => {
  const db = freshDb();
  const kevin = upsertEntity(db, 'person', 'Kevin2', 'old profile');
  const lisbon = upsertEntity(db, 'place', 'Lisbon2');
  const porto = upsertEntity(db, 'place', 'Porto2');
  const tokyo = upsertEntity(db, 'place', 'Tokyo2');
  const eventId = insertCapture(db, new Date().toISOString());
  addRelation(db, kevin.id, 'visited', lisbon.id, eventId);
  addRelation(db, kevin.id, 'visited', porto.id, eventId);
  addRelation(db, kevin.id, 'visited', tokyo.id, eventId);

  const llm = mockLLM(
    'Kevin2 recently visited multiple cities including Lisbon2, Porto2, and Tokyo2.',
  );
  const since = new Date(Date.now() - 1000).toISOString();
  await summarizeHotEntities(db, llm, since);

  const row = db
    .prepare('SELECT profile_generated_at FROM entities WHERE id = ?')
    .get(kevin.id) as {
    profile_generated_at: string | null;
  };
  assert.ok(
    row.profile_generated_at !== null,
    'profile_generated_at should be set after hot-entity summarize',
  );
  const cmp = db
    .prepare(`SELECT datetime(?) >= datetime('now', '-5 seconds') AS ok`)
    .get(row.profile_generated_at) as { ok: number };
  assert.equal(cmp.ok, 1, `profile_generated_at should be recent after hot-entity summarize`);
  closeDb(db);
});
