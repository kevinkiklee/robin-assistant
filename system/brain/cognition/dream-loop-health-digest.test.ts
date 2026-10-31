import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeDb, openDb, type RobinDb } from '../memory/db.ts';
import { allMigrations, applyMigrations } from '../memory/migrations/index.ts';
import { composeLearningDigest, type DreamResult, renderLearningDigest } from './dream.ts';
import {
  expireRecommendation,
  insertRecommendation,
  resolveRecommendation,
} from './recommendations/store.ts';

/**
 * Tier-of-coverage: the loop-health learning-digest fold (design 2026-08-10 §10) —
 * open recommendation count, last-day lapses, and the brief's last-call overflow
 * metric. Lives in its OWN file per the digest-field convention (see
 * dream-habits-digest.test.ts / dream-recommendations-digest.test.ts).
 */

function freshDb(): RobinDb {
  const dir = mkdtempSync(join(tmpdir(), 'robin-loop-health-digest-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

function baseResult(): DreamResult {
  return {
    predictionsResolved: 0,
    brierDeltaSum: 0,
    journalGenerated: false,
    entitiesSummarized: 0,
    arcsCreated: 0,
    candidatesExpired: 0,
    conflictsExpired: 0,
    candidatesDeduped: 0,
    topicsMerged: 0,
    staleFlagsRaised: 0,
    staleBeliefsFlagged: 0,
    beliefsRefreshed: 0,
    claimsRetried: 0,
    claimsRecovered: 0,
    docsIngested: 0,
    correctionsApplied: 0,
    beliefsRetracted: 0,
    candidatesPromoted: 0,
    candidatesConflicted: 0,
    candidatesMerged: 0,
    depthInsightsGenerated: 0,
    digestGenerated: false,
    hygieneRelationsDeleted: 0,
    hygieneEntitiesDeleted: 0,
    hygieneEntitiesAutoCulled: 0,
    hygieneBlocklistGrown: 0,
  };
}

test('digest includes loop health when recommendations table exists', () => {
  const db = freshDb();
  insertRecommendation(db, { subject: 'Open Thing One', claim: 'x', domain: 'creative' });
  const digest = composeLearningDigest(db, baseResult(), new Date('2026-08-10T12:00:00Z'));
  assert.equal(digest.loopHealth?.openRecs, 1);
  assert.equal(digest.loopHealth?.lapsed24h, 0);
  assert.equal(digest.loopHealth?.lastCallOverflow, null, 'no metric row → null');
  const rendered = renderLearningDigest(digest);
  assert.match(rendered, /1 open/);
  assert.match(rendered, /- Loops: 1 open, 0 lapsed in 24h/);
  assert.doesNotMatch(rendered, /last-call overflow/, 'null overflow → no suffix');
  closeDb(db);
});

test('composeLearningDigest: lapsed24h counts only expiries acted within the last day', () => {
  const db = freshDb();
  const now = new Date('2026-08-10T12:00:00Z');

  // Expired 6h ago — inside the 24h window.
  const { id: freshLapse } = insertRecommendation(db, {
    subject: 'fresh lapse',
    claim: 'x',
    domain: 'creative',
  });
  expireRecommendation(db, freshLapse, new Date('2026-08-10T06:00:00Z'));

  // Expired 2 days ago — outside the window.
  const { id: staleLapse } = insertRecommendation(db, {
    subject: 'stale lapse',
    claim: 'x',
    domain: 'travel',
  });
  expireRecommendation(db, staleLapse, new Date('2026-08-08T12:00:00Z'));

  // Acted recently — resolved, but not a lapse.
  const { id: actedId } = insertRecommendation(db, {
    subject: 'acted thing',
    claim: 'x',
    domain: 'home',
  });
  resolveRecommendation(db, actedId, {
    status: 'acted',
    outcome: 'acted',
    actedAt: new Date('2026-08-10T08:00:00Z'),
  });

  const digest = composeLearningDigest(db, baseResult(), now);
  assert.equal(digest.loopHealth?.openRecs, 0);
  assert.equal(digest.loopHealth?.lapsed24h, 1, 'only the fresh expiry counts');
  closeDb(db);
});

test('composeLearningDigest: lastCallOverflow reads the most recent metrics_daily row', () => {
  const db = freshDb();
  const insertMetric = db.prepare(
    `INSERT INTO metrics_daily (day, metric, value, n) VALUES (?, 'lastcall_overflow', ?, 1)`,
  );
  insertMetric.run('2026-08-08', 5);
  insertMetric.run('2026-08-09', 2);

  const digest = composeLearningDigest(db, baseResult(), new Date('2026-08-10T12:00:00Z'));
  assert.equal(digest.loopHealth?.lastCallOverflow, 2, 'latest day wins');
  const rendered = renderLearningDigest(digest);
  assert.match(rendered, /- Loops: 0 open, 0 lapsed in 24h, last-call overflow 2/);
  closeDb(db);
});

test('composeLearningDigest: missing `recommendations` table → loopHealth absent, never throws', () => {
  const db = freshDb();
  // Simulate an older DB where migration 031 has not run.
  db.exec('DROP TABLE recommendations');
  let digest: ReturnType<typeof composeLearningDigest> | undefined;
  assert.doesNotThrow(() => {
    digest = composeLearningDigest(db, baseResult(), new Date('2026-08-10T12:00:00Z'));
  });
  assert.equal(digest?.loopHealth, undefined, 'no table → snapshot absent');
  const rendered = renderLearningDigest(digest as ReturnType<typeof composeLearningDigest>);
  assert.doesNotMatch(rendered, /Loops:/);
  closeDb(db);
});
