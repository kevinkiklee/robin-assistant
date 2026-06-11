import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { believe, recallBelief } from '../memory/belief.ts';
import { closeDb, openDb } from '../memory/db.ts';
import { allMigrations, applyMigrations } from '../memory/migrations/index.ts';
import {
  clearBeliefResolvers,
  registerBeliefResolver,
  runBeliefFreshness,
} from './belief-freshness.ts';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'robin-bf-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

/**
 * Seed a belief then backdate its verified_at and ts to simulate a stale record.
 * Returns the eventId.
 */
function seedStaleBeliefDaysAgo(
  db: ReturnType<typeof freshDb>,
  topic: string,
  claim: string,
  provenance: string,
  daysAgo: number,
  now: Date = new Date(),
): number {
  const r = believe(db, null, { topic, claim, provenance: provenance as never });
  // Backdate relative to the evaluation `now`, not the wall clock — otherwise the
  // seeded age drifts as real time passes and day-boundary staleness checks flip.
  const staleTs = new Date(now.getTime() - daysAgo * 86_400_000).toISOString();
  // Backdate verified_at in payload and the event ts
  db.prepare(
    `UPDATE events
        SET ts = ?,
            payload = json_set(payload, '$.verified_at', ?)
      WHERE id = ?`,
  ).run(staleTs, staleTs, r.eventId);
  return r.eventId;
}

// ---------------------------------------------------------------------------
// Cleanup resolvers before/after every test so registrations don't leak
// ---------------------------------------------------------------------------

test('belief-freshness: first-party belief is never flagged, even when very old', async () => {
  clearBeliefResolvers();
  const db = freshDb();

  // Seed a first-party belief "verified" 1000 days ago — well past any TTL,
  // but first-party has TTL=Infinity so it must NOT be flagged.
  seedStaleBeliefDaysAgo(db, 'user-name', 'Kevin Lee', 'first-party', 1000);

  const result = await runBeliefFreshness(db, null);

  assert.equal(result.scanned, 1);
  assert.equal(result.stale, 0);
  assert.equal(result.flagged, 0);

  // No belief.stale events written
  const count = (
    db.prepare(`SELECT COUNT(*) AS c FROM events WHERE kind = 'belief.stale'`).get() as {
      c: number;
    }
  ).c;
  assert.equal(count, 0);

  closeDb(db);
  clearBeliefResolvers();
});

test('belief-freshness: external belief 10 days old is flagged; re-run same day is idempotent', async () => {
  clearBeliefResolvers();
  const db = freshDb();
  const now = new Date('2026-05-25T12:00:00.000Z');

  // external TTL = 7 days; 10 days old → stale
  seedStaleBeliefDaysAgo(db, 'spotify-last-played', 'Radiohead - Exit Music', 'external', 10, now);

  const r1 = await runBeliefFreshness(db, null, { now });
  assert.equal(r1.scanned, 1);
  assert.equal(r1.stale, 1);
  assert.equal(r1.flagged, 1);
  assert.equal(r1.requeried, 0);

  // One belief.stale event written
  const countAfterFirst = (
    db.prepare(`SELECT COUNT(*) AS c FROM events WHERE kind = 'belief.stale'`).get() as {
      c: number;
    }
  ).c;
  assert.equal(countAfterFirst, 1);

  // Running again the same day must NOT write a second event (idempotency)
  const r2 = await runBeliefFreshness(db, null, { now });
  assert.equal(r2.flagged, 0, 'second run same day must not flag again');

  const countAfterSecond = (
    db.prepare(`SELECT COUNT(*) AS c FROM events WHERE kind = 'belief.stale'`).get() as {
      c: number;
    }
  ).c;
  assert.equal(countAfterSecond, 1, 'must not write a second belief.stale event');

  closeDb(db);
  clearBeliefResolvers();
});

test('belief-freshness: registered resolver refreshes a stale head; requeried is counted', async () => {
  clearBeliefResolvers();
  const db = freshDb();
  const now = new Date('2026-05-25T12:00:00.000Z');

  // Seed a stale external belief for topic "spotify-current-track"
  seedStaleBeliefDaysAgo(db, 'spotify-current-track', 'Old Song', 'external', 10, now);

  // Register a resolver for the "spotify-" prefix
  let resolverCalled = 0;
  registerBeliefResolver('spotify-', async (_head) => {
    resolverCalled++;
    return { claim: 'New Song', confidence: 0.9 };
  });

  const result = await runBeliefFreshness(db, null, { now });

  assert.equal(result.scanned, 1);
  assert.equal(result.stale, 1);
  assert.equal(result.requeried, 1);
  assert.equal(result.flagged, 0, 'resolver succeeded — should not also flag');
  assert.equal(resolverCalled, 1);

  // recallBelief should return the updated head with newer verifiedAt
  const head = recallBelief(db, {
    topic: 'spotify-current-track',
  }) as import('../memory/belief.ts').BeliefRecord;
  assert.ok(head, 'head must exist after re-query');
  assert.equal(head.claim, 'New Song');
  // verifiedAt should be approximately now (within 1 minute tolerance)
  assert.ok(head.verifiedAt, 'verifiedAt must be set');
  const verifiedMs = Date.parse(head.verifiedAt);
  const nowMs = now.getTime();
  assert.ok(
    Math.abs(verifiedMs - nowMs) < 60_000,
    `verifiedAt (${head.verifiedAt}) should be ~now (${now.toISOString()})`,
  );

  closeDb(db);
  clearBeliefResolvers();
});

test('belief-freshness: maxRequeries cap — only first N stale resolvable heads are re-queried', async () => {
  clearBeliefResolvers();
  const db = freshDb();
  const now = new Date('2026-05-25T12:00:00.000Z');

  // Seed two stale external beliefs under the same prefix
  seedStaleBeliefDaysAgo(db, 'spotify-track-a', 'Track A', 'external', 10, now);
  seedStaleBeliefDaysAgo(db, 'spotify-track-b', 'Track B', 'external', 10, now);

  let resolverCalled = 0;
  registerBeliefResolver('spotify-', async (_head) => {
    resolverCalled++;
    return { claim: `Refreshed ${resolverCalled}`, confidence: 0.8 };
  });

  // Cap at 1 — only one of the two stale heads should be re-queried
  const result = await runBeliefFreshness(db, null, { now, maxRequeries: 1 });

  assert.equal(result.scanned, 2);
  assert.equal(result.stale, 2);
  assert.equal(result.requeried, 1, 'only 1 should be re-queried due to cap');
  // The second stale head should have been flagged instead
  assert.equal(result.flagged, 1, 'capped head must fall through to flagging');
  assert.equal(resolverCalled, 1);

  closeDb(db);
  clearBeliefResolvers();
});

// ---------------------------------------------------------------------------
// C2 — risk-weighted re-query selection (confidence + over-age + corrections)
// ---------------------------------------------------------------------------

/** Set the stored confidence of a seeded belief head (payload + column). */
function setConfidence(db: ReturnType<typeof freshDb>, eventId: number, confidence: number): void {
  db.prepare(`UPDATE events SET payload = json_set(payload, '$.confidence', ?) WHERE id = ?`).run(
    confidence,
    eventId,
  );
}

/** Seed N corrections rows on a topic (migration 014 added the topic column). */
function seedCorrections(db: ReturnType<typeof freshDb>, topic: string, n: number): void {
  const stmt = db.prepare(`INSERT INTO corrections (what, correction, topic) VALUES (?, ?, ?)`);
  for (let i = 0; i < n; i++) stmt.run(`what-${topic}-${i}`, `correction-${i}`, topic);
}

test('belief-freshness: re-queries the highest-risk stale head, not the first enumerated', async () => {
  clearBeliefResolvers();
  const db = freshDb();
  const now = new Date('2026-05-25T12:00:00.000Z');

  // Two stale external heads (TTL 7d). Head A is the SAFER one (high confidence,
  // barely past TTL, no corrections); head B is the RISKIER one (low confidence,
  // far past TTL, correction history). Seed B first then A so A is the NEWER row —
  // recallBelief enumerates ts DESC, so the first-N lottery would pick A.
  const idB = seedStaleBeliefDaysAgo(db, 'spotify-track-b', 'Track B', 'external', 60, now);
  setConfidence(db, idB, 0.2);
  seedCorrections(db, 'spotify-track-b', 2);

  const idA = seedStaleBeliefDaysAgo(db, 'spotify-track-a', 'Track A', 'external', 8, now);
  setConfidence(db, idA, 0.9);

  // Sanity: A is the newer row (would win a first-N lottery).
  assert.ok(idA > idB, 'A must be the newer head so the test proves order independence');

  const resolved: string[] = [];
  registerBeliefResolver('spotify-', async (head) => {
    resolved.push(head.topic);
    return { claim: 'Refreshed', confidence: 0.95 };
  });

  // Single re-query slot: only the riskiest head may take it.
  const result = await runBeliefFreshness(db, null, { now, maxRequeries: 1 });

  assert.equal(result.scanned, 2);
  assert.equal(result.stale, 2);
  assert.equal(result.requeried, 1, 'exactly one head re-queried under the cap');
  assert.deepEqual(
    resolved,
    ['spotify-track-b'],
    'the riskier head won the slot, not the newer one',
  );
  assert.equal(result.flagged, 1, 'the safer head falls through to flagging');

  // The safer head A got a belief.stale flag; the riskier head B did not.
  const flagged = db
    .prepare(`SELECT json_extract(payload,'$.topic') AS t FROM events WHERE kind = 'belief.stale'`)
    .all() as Array<{ t: string }>;
  assert.deepEqual(
    flagged.map((r) => r.t),
    ['spotify-track-a'],
  );

  closeDb(db);
  clearBeliefResolvers();
});

test('belief-freshness: correction history on the topic raises the score and wins the slot', async () => {
  clearBeliefResolvers();
  const db = freshDb();
  const now = new Date('2026-05-25T12:00:00.000Z');

  // Two otherwise-identical stale heads — same confidence, same age, same class.
  // The ONLY difference is correction history. Seed the corrected head FIRST so
  // it is the older row and a first-N lottery would pass it over.
  const idCorrected = seedStaleBeliefDaysAgo(db, 'topic-corrected', 'Claim C', 'external', 10, now);
  setConfidence(db, idCorrected, 0.5);
  seedCorrections(db, 'topic-corrected', 3);

  const idClean = seedStaleBeliefDaysAgo(db, 'topic-clean', 'Claim D', 'external', 10, now);
  setConfidence(db, idClean, 0.5);

  assert.ok(idClean > idCorrected, 'clean head is newer (first-N would pick it)');

  const resolved: string[] = [];
  registerBeliefResolver('topic-', async (head) => {
    resolved.push(head.topic);
    return { claim: 'Refreshed' };
  });

  const result = await runBeliefFreshness(db, null, { now, maxRequeries: 1 });

  assert.equal(result.requeried, 1);
  assert.deepEqual(resolved, ['topic-corrected'], 'correction pressure broke the tie');

  closeDb(db);
  clearBeliefResolvers();
});

test('belief-freshness: scoring never throws on null confidence or missing correction topic', async () => {
  clearBeliefResolvers();
  const db = freshDb();
  const now = new Date('2026-05-25T12:00:00.000Z');

  // Head with NULL confidence (never set) and zero corrections — scoring must
  // not throw on the null and the COUNT(*) must return 0, not error.
  seedStaleBeliefDaysAgo(db, 'spotify-null-conf', 'No confidence', 'external', 10, now);
  // A correction row whose topic does NOT match any head — must be ignored,
  // never break the per-topic count.
  seedCorrections(db, 'unrelated-topic', 1);

  let called = 0;
  registerBeliefResolver('spotify-', async () => {
    called++;
    return { claim: 'Refreshed' };
  });

  const result = await runBeliefFreshness(db, null, { now, maxRequeries: 5 });

  assert.equal(result.scanned, 1);
  assert.equal(result.stale, 1);
  assert.equal(result.requeried, 1);
  assert.equal(called, 1);

  closeDb(db);
  clearBeliefResolvers();
});

test('belief-freshness: resolver-less stale heads are flagged regardless of score', async () => {
  clearBeliefResolvers();
  const db = freshDb();
  const now = new Date('2026-05-25T12:00:00.000Z');

  // No resolver registered at all. Two stale heads of very different risk.
  const idHigh = seedStaleBeliefDaysAgo(db, 'alpha-high-risk', 'High', 'external', 90, now);
  setConfidence(db, idHigh, 0.1);
  seedCorrections(db, 'alpha-high-risk', 3);
  seedStaleBeliefDaysAgo(db, 'beta-low-risk', 'Low', 'external', 8, now);

  const result = await runBeliefFreshness(db, null, { now, maxRequeries: 5 });

  assert.equal(result.scanned, 2);
  assert.equal(result.stale, 2);
  assert.equal(result.requeried, 0, 'no resolvers → nothing re-queried');
  assert.equal(result.flagged, 2, 'both stale heads flagged regardless of risk score');

  closeDb(db);
  clearBeliefResolvers();
});

test('belief-freshness: retracted heads are skipped', async () => {
  clearBeliefResolvers();
  const db = freshDb();
  const now = new Date('2026-05-25T12:00:00.000Z');

  // Insert a retracted external belief that would otherwise be stale
  const r = believe(db, null, {
    topic: 'some-retracted',
    claim: 'was true',
    provenance: 'external',
    retracted: true,
  });
  const staleTs = new Date(now.getTime() - 20 * 86_400_000).toISOString();
  db.prepare(
    `UPDATE events SET ts = ?, payload = json_set(payload, '$.verified_at', ?) WHERE id = ?`,
  ).run(staleTs, staleTs, r.eventId);

  const result = await runBeliefFreshness(db, null, { now });
  assert.equal(result.scanned, 0, 'retracted heads must not be scanned');
  assert.equal(result.stale, 0);
  assert.equal(result.flagged, 0);

  closeDb(db);
  clearBeliefResolvers();
});
