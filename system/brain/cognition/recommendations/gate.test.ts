import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeDb, openDb, type RobinDb } from '../../memory/db.ts';
import { ingest } from '../../memory/ingest.ts';
import { allMigrations, applyMigrations } from '../../memory/migrations/index.ts';
import { applyRecommendGate, SessionRecCounter } from './gate.ts';
import { getRecommendation, insertRecommendation, listRecommendations } from './store.ts';

function freshDb(): RobinDb {
  const dir = mkdtempSync(join(tmpdir(), 'robin-rec-gate-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

test('same subject + same verdict → duplicate, evidence bumped, no insert', () => {
  const db = freshDb();
  const { id } = insertRecommendation(db, {
    subject: 'Acme F1',
    claim: 'buy',
    verdict: 'buy',
    domain: 'creative',
  });
  const r = applyRecommendGate(db, {
    subject: 'acme f1',
    claim: 'buy again',
    verdict: 'buy',
    domain: 'creative',
  });
  assert.deepEqual(r, { action: 'duplicate', id });
  assert.equal(listRecommendations(db).length, 1);
  assert.match(getRecommendation(db, id)?.evidence ?? '', /re-recommended/);
  closeDb(db);
});

test('same subject + different verdict → insert + supersede prior', () => {
  const db = freshDb();
  const { id: oldId } = insertRecommendation(db, {
    subject: 'Acme F1',
    claim: 'wait',
    verdict: 'wait',
    domain: 'creative',
  });
  const r = applyRecommendGate(db, {
    subject: 'Acme F1',
    claim: 'buy now',
    verdict: 'buy',
    domain: 'creative',
  });
  assert.equal(r.action, 'superseded');
  assert.ok(r.action === 'superseded' && r.supersededIds.includes(oldId));
  const old = getRecommendation(db, oldId);
  assert.equal(old?.status, 'superseded');
  assert.match(old?.evidence ?? '', new RegExp(`#${r.id}`));
  closeDb(db);
});

test('fresh subject → plain insert with sourceEventId callback', () => {
  const db = freshDb();
  let called = 0;
  let eventId = 0;
  const r = applyRecommendGate(
    db,
    { subject: 'Trailhead Strap', claim: 'try', verdict: 'try', domain: 'creative' },
    () => {
      called += 1;
      // source_event_id is a real FK (foreign_keys = ON) — seed an actual event.
      eventId = ingest(db, null, {
        kind: 'memory.recommendation',
        source: 'mcp',
        content: 'rec',
      }).eventId;
      return eventId;
    },
  );
  assert.equal(r.action, 'inserted');
  assert.equal(called, 1);
  assert.equal(getRecommendation(db, r.id)?.sourceEventId, eventId);
  closeDb(db);
});

test('duplicate path never invokes the sourceEventId callback', () => {
  const db = freshDb();
  insertRecommendation(db, {
    subject: 'Acme F1',
    claim: 'buy',
    verdict: 'buy',
    domain: 'creative',
  });
  let called = 0;
  applyRecommendGate(
    db,
    { subject: 'Acme F1', claim: 'x', verdict: 'buy', domain: 'creative' },
    () => {
      called += 1;
      return null;
    },
  );
  assert.equal(called, 0);
  closeDb(db);
});

test('overlapping subject (containment) → insert + supersede the older open rec', () => {
  const db = freshDb();
  const { id: oldId } = insertRecommendation(db, {
    subject: 'Acme kettle',
    claim: 'avoid',
    verdict: 'avoid',
    domain: 'finance',
  });
  const r = applyRecommendGate(db, {
    subject: 'Acme kettle (refurbished)',
    claim: 'avoid for commuting',
    verdict: 'avoid',
    domain: 'finance',
  });
  assert.equal(r.action, 'superseded');
  assert.ok(r.action === 'superseded' && r.supersededIds.includes(oldId));
  const old = getRecommendation(db, oldId);
  assert.equal(old?.status, 'superseded');
  assert.match(old?.evidence ?? '', /newer rec on the same subject/);
  closeDb(db);
});

test('unrelated single-token overlap does not supersede', () => {
  const db = freshDb();
  const { id } = insertRecommendation(db, {
    subject: 'Acme X1',
    claim: 'x',
    verdict: 'buy',
    domain: 'finance',
  });
  const r = applyRecommendGate(db, {
    subject: 'Acme X2',
    claim: 'y',
    verdict: 'buy',
    domain: 'finance',
  });
  assert.equal(r.action, 'inserted');
  assert.equal(getRecommendation(db, id)?.status, 'open');
  closeDb(db);
});

test('session cap: recs past the daily limit are logged suppressed, not opened', () => {
  const db = freshDb();
  const cap = new SessionRecCounter(2, () => new Date('2026-09-13T20:00:00'));
  const results = ['Alpha One', 'Beta Two', 'Gamma Three'].map((subject) =>
    applyRecommendGate(db, { subject, claim: 'c', verdict: 'try', domain: 'creative' }, undefined, {
      sessionCap: cap,
    }),
  );
  assert.deepEqual(
    results.map((r) => r.action),
    ['inserted', 'inserted', 'suppressed'],
  );
  assert.equal(getRecommendation(db, results[2].id)?.status, 'suppressed');
  // Duplicates of an open rec don't consume the cap and still dedupe.
  const dup = applyRecommendGate(
    db,
    { subject: 'alpha one', claim: 'again', verdict: 'try', domain: 'creative' },
    undefined,
    { sessionCap: cap },
  );
  assert.equal(dup.action, 'duplicate');
  closeDb(db);
});

test('session cap resets on a new local day', () => {
  let now = new Date('2026-09-13T23:00:00');
  const cap = new SessionRecCounter(1, () => now);
  assert.equal(cap.exhausted(), false);
  cap.bump();
  assert.equal(cap.exhausted(), true);
  now = new Date('2026-09-14T08:00:00');
  assert.equal(cap.exhausted(), false);
});
