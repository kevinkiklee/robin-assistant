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
): number {
  const r = believe(db, null, { topic, claim, provenance: provenance as never });
  const staleTs = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
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
  seedStaleBeliefDaysAgo(db, 'spotify-last-played', 'Radiohead - Exit Music', 'external', 10);

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
  seedStaleBeliefDaysAgo(db, 'spotify-current-track', 'Old Song', 'external', 10);

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
  seedStaleBeliefDaysAgo(db, 'spotify-track-a', 'Track A', 'external', 10);
  seedStaleBeliefDaysAgo(db, 'spotify-track-b', 'Track B', 'external', 10);

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
  const staleTs = new Date(Date.now() - 20 * 86_400_000).toISOString();
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
