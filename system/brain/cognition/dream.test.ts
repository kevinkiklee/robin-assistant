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
import { allMigrations, applyMigrations } from '../memory/migrations/index.ts';
import { detectArcs, runDream, summarizeHotEntities } from './dream.ts';

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
  const row = db.prepare(`SELECT outcome FROM predictions LIMIT 1`).get() as { outcome: string };
  assert.equal(row.outcome, 'unverifiable');
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

test('dream: writes narrative journal section when LLM available', async () => {
  const db = freshDb();
  const llm = mockLLM('Today I learned about Kevin and Lisbon. Worked through 3 sessions.');
  await runDream(db, llm);
  const day = new Date().toISOString().slice(0, 10);
  const row = db.prepare(`SELECT body FROM journals WHERE day = ?`).get(day) as { body: string };
  assert.ok(row);
  assert.match(row.body, /Narrative/);
  assert.match(row.body, /Kevin and Lisbon/);
  closeDb(db);
});

test('dream: journal falls back to metrics-only when LLM null', async () => {
  const db = freshDb();
  const r = await runDream(db, null);
  assert.equal(r.entitiesSummarized, 0);
  const day = new Date().toISOString().slice(0, 10);
  const row = db.prepare(`SELECT body FROM journals WHERE day = ?`).get(day) as { body: string };
  // No narrative section when LLM unavailable
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
