import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeDb, openDb, type RobinDb } from '../memory/db.ts';
import { allMigrations, applyMigrations } from '../memory/migrations/index.ts';
import { insertHabit } from './behavior/habits-store.ts';
import { composeLearningDigest, type DreamResult, renderLearningDigest } from './dream.ts';

/**
 * Tier-of-coverage: the §5/§9 learning-digest fold for behavioral habits. Lives in its
 * OWN file (the canonical dream.test.ts is owned by a sibling agent and not edited here).
 */

function freshDb(): RobinDb {
  const dir = mkdtempSync(join(tmpdir(), 'robin-habit-digest-'));
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

test('composeLearningDigest: folds habit lifecycle counts + 24h deltas', () => {
  const db = freshDb();
  const now = new Date();
  const recently = new Date(now.getTime() - 3_600_000); // 1h ago, within the 24h window

  // 2 soft (one fresh this window), 1 graduated (updated this window), 1 retired.
  insertHabit(db, {
    statement: 'old soft',
    domain: 'creative',
    patternKind: 'temporal',
    status: 'soft',
    firstSeen: '2026-01-01 00:00:00',
  });
  // Backdate created_at so it is NOT counted as new.
  db.prepare(
    `UPDATE habits SET created_at = '2026-01-01 00:00:00' WHERE statement = 'old soft'`,
  ).run();

  insertHabit(db, {
    statement: 'fresh soft',
    domain: 'creative',
    patternKind: 'purchase',
    status: 'soft',
  });
  db.prepare(`UPDATE habits SET created_at = ? WHERE statement = 'fresh soft'`).run(
    recently.toISOString().slice(0, 19).replace('T', ' '),
  );

  insertHabit(db, {
    statement: 'graduated one',
    domain: 'preferences',
    patternKind: 'preference',
    status: 'graduated',
  });
  db.prepare(`UPDATE habits SET updated_at = ? WHERE statement = 'graduated one'`).run(
    recently.toISOString().slice(0, 19).replace('T', ' '),
  );

  insertHabit(db, {
    statement: 'retired one',
    domain: 'finance',
    patternKind: 'purchase',
    status: 'retired',
  });

  const digest = composeLearningDigest(db, baseResult(), now);
  assert.ok(digest.habits, 'habit snapshot present');
  assert.equal(digest.habits?.soft, 2);
  assert.equal(digest.habits?.graduated, 1);
  assert.equal(digest.habits?.retired, 1);
  assert.equal(digest.habits?.newSoft, 1, 'only the fresh soft counts as new');
  assert.equal(digest.habits?.newGraduated, 1);
  closeDb(db);
});

test('renderLearningDigest: emits a Habits line with the 24h deltas', () => {
  const db = freshDb();
  const now = new Date();
  insertHabit(db, { statement: 'a', domain: 'creative', patternKind: 'temporal', status: 'soft' });
  insertHabit(db, {
    statement: 'b',
    domain: 'preferences',
    patternKind: 'preference',
    status: 'graduated',
  });
  const digest = composeLearningDigest(db, baseResult(), now);
  const text = renderLearningDigest(digest);
  assert.match(text, /- Habits: 1 soft, 1 graduated, 0 retired/);
  closeDb(db);
});

test('renderLearningDigest: no Habits line when there are no habits at all', () => {
  const db = freshDb();
  const digest = composeLearningDigest(db, baseResult(), new Date());
  // Snapshot exists (table present) but everything is zero → no habit line rendered.
  assert.deepEqual(digest.habits, {
    soft: 0,
    graduated: 0,
    retired: 0,
    newSoft: 0,
    newGraduated: 0,
  });
  const text = renderLearningDigest(digest);
  assert.doesNotMatch(text, /Habits:/);
  closeDb(db);
});
