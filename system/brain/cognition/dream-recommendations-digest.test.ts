import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeDb, openDb, type RobinDb } from '../memory/db.ts';
import { allMigrations, applyMigrations } from '../memory/migrations/index.ts';
import { composeLearningDigest, type DreamResult, renderLearningDigest } from './dream.ts';
import { insertRecommendation, resolveRecommendation } from './recommendations/store.ts';

/**
 * Tier-of-coverage: the §6 learning-digest fold for recommendation calibration (Goal C).
 * Lives in its OWN file (the canonical dream.test.ts is owned by a sibling agent and not
 * edited here), modeled on dream-habits-digest.test.ts.
 */

function freshDb(): RobinDb {
  const dir = mkdtempSync(join(tmpdir(), 'robin-rec-digest-'));
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

/** Record a recommendation and immediately resolve it to a terminal status/outcome. */
function recordResolved(
  db: RobinDb,
  subject: string,
  domain: Parameters<typeof insertRecommendation>[1]['domain'],
  status: 'acted' | 'expired' | 'declined',
): void {
  const { id } = insertRecommendation(db, { subject, claim: `try ${subject}`, domain });
  resolveRecommendation(db, id, {
    status,
    outcome: status === 'acted' ? 'acted' : 'not_acted',
    evidence: `test: ${status}`,
  });
}

test('composeLearningDigest: folds recommendation calibration (counts + actedRate + byDomain)', () => {
  const db = freshDb();

  // creative: 2 acted + 1 expired (resolved 3, acted 2)
  recordResolved(db, 'Nikon Z TC-1.4x', 'creative', 'acted');
  recordResolved(db, 'Voigtlander 35 APO', 'creative', 'acted');
  recordResolved(db, 'Plena 135', 'creative', 'expired');
  // finance: 1 acted + 1 declined (resolved 2, acted 1)
  recordResolved(db, 'roth conversion', 'finance', 'acted');
  recordResolved(db, 'i bonds', 'finance', 'declined');
  // travel: 1 open (no resolution → contributes to open, not to byDomain)
  insertRecommendation(db, { subject: 'kyoto trip', claim: 'go in autumn', domain: 'travel' });
  // superseded: excluded from both the open count and the resolved denominator
  const { id: supId } = insertRecommendation(db, {
    subject: 'old body',
    claim: 'upgrade',
    domain: 'creative',
  });
  resolveRecommendation(db, supId, { status: 'superseded', outcome: 'unknown' });

  const digest = composeLearningDigest(db, baseResult(), new Date());
  assert.ok(digest.recommendations, 'recommendation snapshot present');
  const r = digest.recommendations;
  assert.equal(r?.open, 1, 'one open rec');
  assert.equal(r?.acted, 3, 'three acted (2 creative + 1 finance)');
  assert.equal(r?.expired, 1);
  assert.equal(r?.declined, 1);
  // actedRate = acted / (acted+expired+declined) = 3 / 5
  assert.equal(r?.actedRate, 3 / 5);

  // byDomain — only domains with ≥1 resolved rec, sorted by resolved desc.
  assert.deepEqual(r?.byDomain, [
    { domain: 'creative', acted: 2, resolved: 3 },
    { domain: 'finance', acted: 1, resolved: 2 },
  ]);

  // The rendered line appears with the acted-rate + top-domains breakdown.
  const text = renderLearningDigest(digest);
  assert.match(
    text,
    /- Recommendations: 3\/5 acted \(60%\); top domains: creative 2\/3, finance 1\/2/,
  );
  closeDb(db);
});

test('composeLearningDigest: open-only recs yield actedRate null and no top-domains breakdown', () => {
  const db = freshDb();
  insertRecommendation(db, { subject: 'a thing', claim: 'consider it', domain: 'home' });
  insertRecommendation(db, { subject: 'another thing', claim: 'consider it', domain: 'home' });

  const digest = composeLearningDigest(db, baseResult(), new Date());
  assert.equal(digest.recommendations?.open, 2);
  assert.equal(digest.recommendations?.actedRate, null, 'no resolved recs → null rate');
  assert.deepEqual(digest.recommendations?.byDomain, [], 'no resolved recs → empty byDomain');

  // The line still renders (there ARE recs), with no pct and no top-domains suffix.
  const text = renderLearningDigest(digest);
  assert.match(text, /- Recommendations: 0\/0 acted$/m);
  assert.doesNotMatch(text, /top domains/);
  closeDb(db);
});

test('renderLearningDigest: no Recommendations line when there are no recs at all', () => {
  const db = freshDb();
  const digest = composeLearningDigest(db, baseResult(), new Date());
  // Snapshot exists (table present) but everything is zero → no rec line rendered.
  assert.deepEqual(digest.recommendations, {
    open: 0,
    acted: 0,
    expired: 0,
    declined: 0,
    actedRate: null,
    byDomain: [],
  });
  const text = renderLearningDigest(digest);
  assert.doesNotMatch(text, /Recommendations:/);
  closeDb(db);
});

test('composeLearningDigest: missing `recommendations` table → snapshot absent, never throws', () => {
  const db = freshDb();
  // Simulate an older DB where migration 031 has not run.
  db.exec('DROP TABLE recommendations');
  let digest: ReturnType<typeof composeLearningDigest> | undefined;
  assert.doesNotThrow(() => {
    digest = composeLearningDigest(db, baseResult(), new Date());
  });
  assert.equal(digest?.recommendations, undefined, 'no table → snapshot absent');
  const text = renderLearningDigest(digest as ReturnType<typeof composeLearningDigest>);
  assert.doesNotMatch(text, /Recommendations:/);
  closeDb(db);
});
