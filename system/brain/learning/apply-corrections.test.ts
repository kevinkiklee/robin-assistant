import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setOperatorProfileForTests } from '../../lib/operator-profile.ts';
import { promoteStableCandidates } from '../cognition/dream.ts';
import { believe, recallBelief } from '../memory/belief.ts';
import { insertBeliefCandidate } from '../memory/belief-candidate.ts';
import { closeDb, openDb } from '../memory/db.ts';
import { allMigrations, applyMigrations } from '../memory/migrations/index.ts';
import { applyCorrections } from './apply-corrections.ts';

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
  const dir = mkdtempSync(join(tmpdir(), 'robin-ac-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

test('applyCorrections: retracts live belief head when correction has matching topic', () => {
  const db = freshDb();

  // Write a live belief on topic 'sam.foo'
  believe(db, null, { topic: 'sam.foo', claim: 'Sam lives in Oregon' });

  // Record a topic-linked correction
  db.prepare(`INSERT INTO corrections (what, correction, context, topic) VALUES (?, ?, ?, ?)`).run(
    'Sam lives in Oregon',
    'Sam lives in NY',
    'user clarification',
    'sam.foo',
  );

  const result = applyCorrections(db, null);

  // Retraction should have been written
  assert.equal(result.retracted, 1, 'expected 1 retraction');
  assert.equal(result.processed, 1, 'expected 1 processed');

  // The false claim is retracted AND the corrected value is now the live head.
  const head = recallBelief(db, { topic: 'sam.foo' });
  assert.ok(head && !Array.isArray(head), 'expected a single head');
  assert.equal(head.retracted, false, 'corrected head should be live, not retracted');
  assert.equal(head.claim, 'Sam lives in NY', 'head should assert the corrected value');
  assert.equal(head.provenance, 'first-party', 'provenance should be first-party');

  // The correction should be marked applied
  const correction = db
    .prepare(`SELECT applied FROM corrections WHERE topic = 'sam.foo'`)
    .get() as { applied: number };
  assert.equal(correction.applied, 1, 'correction should be marked applied=1');

  closeDb(db);
});

test('applyCorrections: re-running is a no-op (already applied corrections are skipped)', () => {
  const db = freshDb();

  believe(db, null, { topic: 'sam.bar', claim: 'Sam is 30' });
  db.prepare(`INSERT INTO corrections (what, correction, context, topic) VALUES (?, ?, ?, ?)`).run(
    'Sam is 30',
    'Sam is 31',
    null,
    'sam.bar',
  );

  const first = applyCorrections(db, null);
  assert.equal(first.processed, 1);
  assert.equal(first.retracted, 1);

  const second = applyCorrections(db, null);
  assert.equal(second.processed, 0, 're-run should process 0 (already applied)');
  assert.equal(second.retracted, 0, 're-run should retract 0');

  closeDb(db);
});

test('applyCorrections: correction with topic but no existing belief → applied=1, retracted=0, no crash', () => {
  const db = freshDb();

  // No belief written for 'sam.baz'
  db.prepare(`INSERT INTO corrections (what, correction, context, topic) VALUES (?, ?, ?, ?)`).run(
    'something wrong',
    'actually correct',
    null,
    'sam.baz',
  );

  const result = applyCorrections(db, null);
  assert.equal(result.processed, 1, 'should process the correction even with no belief head');
  assert.equal(result.retracted, 0, 'nothing to retract when no belief exists');

  const correction = db
    .prepare(`SELECT applied FROM corrections WHERE topic = 'sam.baz'`)
    .get() as { applied: number };
  assert.equal(correction.applied, 1, 'correction should be marked applied=1');

  closeDb(db);
});

test('applyCorrections: correction with NULL topic is left applied=0 and untouched', () => {
  const db = freshDb();

  // Behavioral/global correction — no topic
  db.prepare(`INSERT INTO corrections (what, correction, context) VALUES (?, ?, ?)`).run(
    'Robin was too verbose',
    'Be more concise',
    null,
  );

  const result = applyCorrections(db, null);
  assert.equal(result.processed, 0, 'NULL-topic corrections should not be processed');
  assert.equal(result.retracted, 0);

  const correction = db.prepare(`SELECT applied FROM corrections WHERE topic IS NULL`).get() as {
    applied: number;
  };
  assert.equal(correction.applied, 0, 'NULL-topic correction should remain applied=0');

  closeDb(db);
});

test('applyCorrections: a corrected topic keeps a live head, so no belief is left headless', () => {
  const db = freshDb();

  // No prior head — the correction is the first thing said about this topic.
  db.prepare(`INSERT INTO corrections (what, correction, context, topic) VALUES (?, ?, ?, ?)`).run(
    'Robin claimed Sam owns an Acme K1 kayak',
    'Sam sold the Acme K1 kayak last year',
    null,
    'outdoor-gear-k1-kayak',
  );

  const result = applyCorrections(db, null);
  assert.equal(result.processed, 1);
  assert.equal(result.asserted, 1, 'corrected value should be asserted as a head');

  const head = recallBelief(db, { topic: 'outdoor-gear-k1-kayak' });
  assert.ok(head && !Array.isArray(head), 'corrected topic must not be headless');
  assert.equal(head.retracted, false);
  assert.equal(head.claim, 'Sam sold the Acme K1 kayak last year');

  closeDb(db);
});

test('applyCorrections: stale re-derivation on a corrected topic is flagged, not promoted', async () => {
  const db = freshDb();
  const now = new Date();
  const tenDaysAgo = new Date(now.getTime() - 10 * 86_400_000)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');

  // The false belief Robin originally held.
  believe(db, null, {
    topic: 'outdoor-gear-k1-kayak',
    claim: 'Sam owns an Acme K1 kayak',
  });

  // The operator corrects it.
  db.prepare(`INSERT INTO corrections (what, correction, context, topic) VALUES (?, ?, ?, ?)`).run(
    'Sam owns an Acme K1 kayak',
    'Sam sold the Acme K1 kayak last year',
    null,
    'outdoor-gear-k1-kayak',
  );
  applyCorrections(db, null);

  // The biographer later re-derives the stale claim from old source text.
  const c = insertBeliefCandidate(db, {
    topic: 'outdoor-gear-k1-kayak',
    claim: 'Sam owns an Acme K1 kayak',
    confidence: 0.9,
    provenance: 'first-party',
  });
  db.prepare(`UPDATE belief_candidates SET created_at = ? WHERE id = ?`).run(tenDaysAgo, c.id);

  const res = await promoteStableCandidates(db, now);

  // Before the fix the corrected topic was headless, so this was PROMOTED —
  // the path by which a stale ownership claim could come back.
  assert.equal(res.promoted, 0, 'stale re-derivation must not be promoted');
  assert.equal(res.conflicted, 1, 'it must be flagged against the corrected head');

  closeDb(db);
});

test('record_correction: persists topic column via direct insert', () => {
  const db = freshDb();

  db.prepare(`INSERT INTO corrections (what, correction, context, topic) VALUES (?, ?, ?, ?)`).run(
    'Robin said X',
    'Actually Y',
    'context',
    'sam.topic-test',
  );

  const row = db
    .prepare(`SELECT what, correction, context, topic FROM corrections WHERE topic = ?`)
    .get('sam.topic-test') as {
    what: string;
    correction: string;
    context: string;
    topic: string;
  };

  assert.ok(row, 'row should exist');
  assert.equal(row.what, 'Robin said X');
  assert.equal(row.correction, 'Actually Y');
  assert.equal(row.context, 'context');
  assert.equal(row.topic, 'sam.topic-test');

  closeDb(db);
});
