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
