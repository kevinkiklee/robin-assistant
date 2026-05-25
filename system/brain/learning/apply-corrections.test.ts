import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { believe, recallBelief } from '../memory/belief.ts';
import { closeDb, openDb } from '../memory/db.ts';
import { allMigrations, applyMigrations } from '../memory/migrations/index.ts';
import { applyCorrections } from './apply-corrections.ts';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'robin-ac-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

test('applyCorrections: retracts live belief head when correction has matching topic', () => {
  const db = freshDb();

  // Write a live belief on topic 'kevin.foo'
  believe(db, null, { topic: 'kevin.foo', claim: 'Kevin lives in NJ' });

  // Record a topic-linked correction
  db.prepare(`INSERT INTO corrections (what, correction, context, topic) VALUES (?, ?, ?, ?)`).run(
    'Kevin lives in NJ',
    'Kevin lives in NY',
    'user clarification',
    'kevin.foo',
  );

  const result = applyCorrections(db, null);

  // Retraction should have been written
  assert.equal(result.retracted, 1, 'expected 1 retraction');
  assert.equal(result.processed, 1, 'expected 1 processed');

  // The live head for that topic should now be retracted
  const head = recallBelief(db, { topic: 'kevin.foo' });
  assert.ok(head && !Array.isArray(head), 'expected a single head');
  assert.equal(head.retracted, true, 'head should be retracted');
  assert.equal(head.provenance, 'first-party', 'provenance should be first-party');

  // The correction should be marked applied
  const correction = db
    .prepare(`SELECT applied FROM corrections WHERE topic = 'kevin.foo'`)
    .get() as { applied: number };
  assert.equal(correction.applied, 1, 'correction should be marked applied=1');

  closeDb(db);
});

test('applyCorrections: re-running is a no-op (already applied corrections are skipped)', () => {
  const db = freshDb();

  believe(db, null, { topic: 'kevin.bar', claim: 'Kevin is 30' });
  db.prepare(`INSERT INTO corrections (what, correction, context, topic) VALUES (?, ?, ?, ?)`).run(
    'Kevin is 30',
    'Kevin is 31',
    null,
    'kevin.bar',
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

  // No belief written for 'kevin.baz'
  db.prepare(`INSERT INTO corrections (what, correction, context, topic) VALUES (?, ?, ?, ?)`).run(
    'something wrong',
    'actually correct',
    null,
    'kevin.baz',
  );

  const result = applyCorrections(db, null);
  assert.equal(result.processed, 1, 'should process the correction even with no belief head');
  assert.equal(result.retracted, 0, 'nothing to retract when no belief exists');

  const correction = db
    .prepare(`SELECT applied FROM corrections WHERE topic = 'kevin.baz'`)
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

test('record_correction: persists topic column via direct insert', () => {
  const db = freshDb();

  db.prepare(`INSERT INTO corrections (what, correction, context, topic) VALUES (?, ?, ?, ?)`).run(
    'Robin said X',
    'Actually Y',
    'context',
    'kevin.topic-test',
  );

  const row = db
    .prepare(`SELECT what, correction, context, topic FROM corrections WHERE topic = ?`)
    .get('kevin.topic-test') as {
    what: string;
    correction: string;
    context: string;
    topic: string;
  };

  assert.ok(row, 'row should exist');
  assert.equal(row.what, 'Robin said X');
  assert.equal(row.correction, 'Actually Y');
  assert.equal(row.context, 'context');
  assert.equal(row.topic, 'kevin.topic-test');

  closeDb(db);
});
