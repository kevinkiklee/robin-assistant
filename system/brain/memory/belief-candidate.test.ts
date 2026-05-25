import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { type BeliefRecord, recallBelief } from './belief.ts';
import {
  countPendingCandidates,
  expireStaleCandidates,
  insertBeliefCandidate,
  listBeliefCandidates,
  resolveBeliefCandidate,
} from './belief-candidate.ts';
import { closeDb, openDb } from './db.ts';
import { allMigrations, applyMigrations } from './migrations/index.ts';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'robin-belief-cand-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

test('belief-candidate: insert normalizes topic and lists as pending', () => {
  const db = freshDb();
  const { id } = insertBeliefCandidate(db, {
    topic: 'Google Role',
    claim: 'Kevin works on Ad Experiences',
    confidence: 0.8,
  });
  assert.ok(id > 0);
  const pending = listBeliefCandidates(db, { status: 'pending' });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].topic, 'google-role'); // normalized
  assert.equal(pending[0].claim, 'Kevin works on Ad Experiences');
  assert.equal(pending[0].confidence, 0.8);
  assert.equal(pending[0].status, 'pending');
  assert.equal(pending[0].sourceEventId, null);
  closeDb(db);
});

test('belief-candidate: duplicate pending topic+claim is deduped (returns existing id)', () => {
  const db = freshDb();
  const a = insertBeliefCandidate(db, { topic: 't', claim: 'same claim' });
  const b = insertBeliefCandidate(db, { topic: 'T', claim: 'same claim' }); // case-different topic
  assert.equal(a.id, b.id);
  assert.equal(countPendingCandidates(db), 1);
  closeDb(db);
});

test('belief-candidate: different claim on same topic is a separate candidate', () => {
  const db = freshDb();
  insertBeliefCandidate(db, { topic: 't', claim: 'v1' });
  insertBeliefCandidate(db, { topic: 't', claim: 'v2' });
  assert.equal(countPendingCandidates(db), 2);
  closeDb(db);
});

test('belief-candidate: insert rejects empty topic/claim', () => {
  const db = freshDb();
  assert.throws(() => insertBeliefCandidate(db, { topic: '   ', claim: 'x' }));
  assert.throws(() => insertBeliefCandidate(db, { topic: 't', claim: '   ' }));
  closeDb(db);
});

test('belief-candidate: promote routes through believe() and reflects in recallBelief', () => {
  const db = freshDb();
  const { id } = insertBeliefCandidate(db, {
    topic: 'google-role',
    claim: 'Ad Experiences',
    confidence: 0.9,
  });
  const res = resolveBeliefCandidate(db, null, id, 'promote');
  assert.equal(res.action, 'promote');
  assert.ok(res.promotedBeliefEventId && res.promotedBeliefEventId > 0);

  // Candidate marked promoted + resolved.
  const all = listBeliefCandidates(db, {});
  assert.equal(all[0].status, 'promoted');
  assert.ok(all[0].resolvedAt);
  assert.equal(countPendingCandidates(db), 0);

  // The promoted claim is now the head belief.
  const head = recallBelief(db, { topic: 'google-role' }) as BeliefRecord;
  assert.ok(head);
  assert.equal(head.claim, 'Ad Experiences');
  assert.equal(head.confidence, 0.9);
  closeDb(db);
});

test('belief-candidate: reject marks rejected with no belief written', () => {
  const db = freshDb();
  const { id } = insertBeliefCandidate(db, { topic: 't', claim: 'maybe' });
  const res = resolveBeliefCandidate(db, null, id, 'reject', 'not durable');
  assert.equal(res.action, 'reject');
  assert.equal(res.promotedBeliefEventId, null);
  const all = listBeliefCandidates(db, {});
  assert.equal(all[0].status, 'rejected');
  assert.ok(all[0].resolvedAt);
  // No belief.update event was created.
  const beliefs = recallBelief(db, {}) as BeliefRecord[];
  assert.equal(beliefs.length, 0);
  closeDb(db);
});

test('belief-candidate: resolving a non-pending candidate throws', () => {
  const db = freshDb();
  const { id } = insertBeliefCandidate(db, { topic: 't', claim: 'x' });
  resolveBeliefCandidate(db, null, id, 'reject');
  assert.throws(() => resolveBeliefCandidate(db, null, id, 'promote'));
  closeDb(db);
});

test('belief-candidate: resolving a missing candidate throws', () => {
  const db = freshDb();
  assert.throws(() => resolveBeliefCandidate(db, null, 9999, 'promote'));
  closeDb(db);
});

test('belief-candidate: countPendingCandidates ignores resolved rows', () => {
  const db = freshDb();
  const a = insertBeliefCandidate(db, { topic: 'a', claim: 'a' });
  insertBeliefCandidate(db, { topic: 'b', claim: 'b' });
  insertBeliefCandidate(db, { topic: 'c', claim: 'c' });
  assert.equal(countPendingCandidates(db), 3);
  resolveBeliefCandidate(db, null, a.id, 'reject');
  assert.equal(countPendingCandidates(db), 2);
  closeDb(db);
});

test('belief-candidate: expireStaleCandidates rejects pending older than the window', () => {
  const db = freshDb();
  // Insert with an explicitly-old created_at so we control staleness.
  db.prepare(
    `INSERT INTO belief_candidates (topic, claim, status, created_at)
     VALUES ('old', 'stale claim', 'pending', '2026-05-01 00:00:00')`,
  ).run();
  insertBeliefCandidate(db, { topic: 'fresh', claim: 'recent claim' });

  // Anchor "now" at 2026-05-24; the 14-day cutoff is 2026-05-10, so 'old' expires.
  const now = new Date('2026-05-24T12:00:00Z');
  const n = expireStaleCandidates(db, 14, now);
  assert.equal(n, 1);

  const oldRow = listBeliefCandidates(db, {}).find((c) => c.topic === 'old');
  assert.ok(oldRow);
  assert.equal(oldRow.status, 'rejected');
  assert.ok(oldRow.resolvedAt);
  // Fresh one stays pending.
  assert.equal(countPendingCandidates(db), 1);
  closeDb(db);
});

test('belief-candidate: expireStaleCandidates leaves promoted/rejected rows untouched', () => {
  const db = freshDb();
  db.prepare(
    `INSERT INTO belief_candidates (topic, claim, status, created_at)
     VALUES ('done', 'already promoted', 'promoted', '2026-01-01 00:00:00')`,
  ).run();
  const now = new Date('2026-05-24T12:00:00Z');
  const n = expireStaleCandidates(db, 14, now);
  assert.equal(n, 0);
  const row = listBeliefCandidates(db, {})[0];
  assert.equal(row.status, 'promoted');
  closeDb(db);
});

test('belief-candidate: expireStaleCandidates respects a custom window', () => {
  const db = freshDb();
  db.prepare(
    `INSERT INTO belief_candidates (topic, claim, status, created_at)
     VALUES ('weekold', 'claim', 'pending', '2026-05-17 00:00:00')`,
  ).run();
  const now = new Date('2026-05-24T12:00:00Z');
  // 14-day window: 7-day-old row survives.
  assert.equal(expireStaleCandidates(db, 14, now), 0);
  // 3-day window: now it expires.
  assert.equal(expireStaleCandidates(db, 3, now), 1);
  closeDb(db);
});

// ─── P3 formation gate tests ──────────────────────────────────────────────────

test('belief-candidate P3: insertBeliefCandidate persists and reads back provenance', () => {
  const db = freshDb();
  const { id } = insertBeliefCandidate(db, {
    topic: 'test-topic',
    claim: 'some claim',
    confidence: 0.9,
    provenance: 'first-party',
  });
  const candidates = listBeliefCandidates(db, { status: 'pending' });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].id, id);
  assert.equal(candidates[0].provenance, 'first-party');
  closeDb(db);
});

test('belief-candidate P3: insertBeliefCandidate stores null provenance when omitted', () => {
  const db = freshDb();
  insertBeliefCandidate(db, { topic: 'no-prov', claim: 'claim without provenance' });
  const candidates = listBeliefCandidates(db, { status: 'pending' });
  assert.equal(candidates[0].provenance, null);
  closeDb(db);
});

test('belief-candidate P3: promoting an external candidate writes NO belief and marks rejected', () => {
  const db = freshDb();
  const { id } = insertBeliefCandidate(db, {
    topic: 'gh-stars',
    claim: 'repo has 1234 stars',
    confidence: 0.99,
    provenance: 'external',
  });
  const res = resolveBeliefCandidate(db, null, id, 'promote');
  // Gate should block — actual action is reject, not promote.
  assert.equal(res.action, 'reject');
  assert.equal(res.promotedBeliefEventId, null);
  assert.equal(res.blockedReason, 'external-not-durable');
  // Candidate is marked rejected in the DB.
  const row = listBeliefCandidates(db, {})[0];
  assert.equal(row.status, 'rejected');
  assert.ok(row.resolvedAt);
  // No belief event written.
  const belief = recallBelief(db, { topic: 'gh-stars' });
  assert.equal(belief, null);
  closeDb(db);
});

test('belief-candidate P3: promoting inferred below 0.85 is blocked with blockedReason', () => {
  const db = freshDb();
  const { id } = insertBeliefCandidate(db, {
    topic: 'user-pref',
    claim: 'prefers dark mode',
    confidence: 0.7, // below 0.85 threshold for inferred
    provenance: 'inferred',
  });
  const res = resolveBeliefCandidate(db, null, id, 'promote');
  assert.equal(res.action, 'reject');
  assert.equal(res.promotedBeliefEventId, null);
  assert.equal(res.blockedReason, 'below-threshold-for-class');
  const row = listBeliefCandidates(db, {})[0];
  assert.equal(row.status, 'rejected');
  const belief = recallBelief(db, { topic: 'user-pref' });
  assert.equal(belief, null);
  closeDb(db);
});

test('belief-candidate P3: promoting inferred at exactly 0.85 succeeds', () => {
  const db = freshDb();
  const { id } = insertBeliefCandidate(db, {
    topic: 'user-pref',
    claim: 'prefers dark mode',
    confidence: 0.85, // exactly at threshold
    provenance: 'inferred',
  });
  const res = resolveBeliefCandidate(db, null, id, 'promote');
  assert.equal(res.action, 'promote');
  assert.ok(res.promotedBeliefEventId && res.promotedBeliefEventId > 0);
  assert.equal(res.blockedReason, undefined);
  const row = listBeliefCandidates(db, {})[0];
  assert.equal(row.status, 'promoted');
  closeDb(db);
});

test('belief-candidate P3: promoted belief carries the correct provenance tag', () => {
  const db = freshDb();
  const { id } = insertBeliefCandidate(db, {
    topic: 'home-location',
    claim: 'lives in Bergen County NJ',
    confidence: 0.95,
    provenance: 'first-party',
  });
  resolveBeliefCandidate(db, null, id, 'promote');
  const belief = recallBelief(db, { topic: 'home-location' }) as import('./belief.ts').BeliefRecord;
  assert.ok(belief);
  assert.equal(belief.claim, 'lives in Bergen County NJ');
  assert.equal(belief.provenance, 'first-party');
  closeDb(db);
});

test('belief-candidate P3: promoted belief carries the provenance from an inferred candidate', () => {
  const db = freshDb();
  const { id } = insertBeliefCandidate(db, {
    topic: 'work-style',
    claim: 'prefers async communication',
    confidence: 0.9, // above 0.85 inferred threshold
    provenance: 'inferred',
  });
  resolveBeliefCandidate(db, null, id, 'promote');
  const belief = recallBelief(db, { topic: 'work-style' }) as import('./belief.ts').BeliefRecord;
  assert.ok(belief);
  assert.equal(belief.provenance, 'inferred');
  closeDb(db);
});

test('belief-candidate P3: null provenance falls back to unknown class (threshold 0.8)', () => {
  const db = freshDb();
  // Below unknown threshold (0.8) — should be blocked
  const { id: lowId } = insertBeliefCandidate(db, {
    topic: 'some-fact',
    claim: 'weak unknown claim',
    confidence: 0.75,
    provenance: null,
  });
  const resLow = resolveBeliefCandidate(db, null, lowId, 'promote');
  assert.equal(resLow.action, 'reject');
  assert.equal(resLow.blockedReason, 'below-threshold-for-class');

  // At/above unknown threshold (0.8) — should promote
  const { id: highId } = insertBeliefCandidate(db, {
    topic: 'some-fact-2',
    claim: 'strong unknown claim',
    confidence: 0.8,
    provenance: null,
  });
  const resHigh = resolveBeliefCandidate(db, null, highId, 'promote');
  assert.equal(resHigh.action, 'promote');
  assert.ok(resHigh.promotedBeliefEventId);
  closeDb(db);
});

test('belief-candidate P3: existing promote test still works with first-party provenance (>= 0.5)', () => {
  // Regression guard: the pre-P3 promote test inserted confidence=0.9 with no
  // provenance, which now falls back to 'unknown' (threshold 0.8). Explicitly
  // set provenance='first-party' here to assert the happy path remains intact.
  const db = freshDb();
  const { id } = insertBeliefCandidate(db, {
    topic: 'fp-topic',
    claim: 'a first-party claim',
    confidence: 0.6, // above first-party threshold of 0.5
    provenance: 'first-party',
  });
  const res = resolveBeliefCandidate(db, null, id, 'promote');
  assert.equal(res.action, 'promote');
  assert.ok(res.promotedBeliefEventId && res.promotedBeliefEventId > 0);
  const belief = recallBelief(db, { topic: 'fp-topic' }) as import('./belief.ts').BeliefRecord;
  assert.ok(belief);
  assert.equal(belief.provenance, 'first-party');
  closeDb(db);
});
