import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { believe, normalizeTopic, recallBelief } from './belief.ts';
import { closeDb, openDb } from './db.ts';
import { allMigrations, applyMigrations } from './migrations/index.ts';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'robin-belief-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

test('belief: write then recall current truth', () => {
  const db = freshDb();
  believe(db, null, { topic: 'whoop.recovery', claim: 'dips after redeye', date: '2026-05-23' });
  const b = recallBelief(db, { topic: 'whoop.recovery' });
  assert.ok(b && !Array.isArray(b));
  assert.equal((b as any).claim, 'dips after redeye');
  closeDb(db);
});

test('belief: normalize collides _ and - and case', () => {
  assert.equal(normalizeTopic('Whoop.Recovery_X'), normalizeTopic('whoop.recovery-x'));
});

test('belief: same-day re-write upserts (no new row, no self-supersede)', () => {
  const db = freshDb();
  believe(db, null, { topic: 't', claim: 'v1', date: '2026-05-23' });
  const b = believe(db, null, { topic: 't', claim: 'v2', date: '2026-05-23' });
  const rows = db.prepare(`SELECT COUNT(*) c FROM events WHERE kind='belief.update'`).get() as {
    c: number;
  };
  assert.equal(rows.c, 1);
  assert.equal(b.supersededEventId, null);
  const cur = recallBelief(db, { topic: 't' }) as any;
  assert.equal(cur.claim, 'v2');
  closeDb(db);
});

test('belief: cross-day write supersedes yesterday', () => {
  const db = freshDb();
  const a = believe(db, null, { topic: 't', claim: 'v1', date: '2026-05-23' });
  const b = believe(db, null, { topic: 't', claim: 'v2', date: '2026-05-24' });
  assert.equal(b.supersededEventId, a.eventId);
  const chain = recallBelief(db, { topic: 't', history: true }) as any[];
  assert.equal(chain.length, 2);
  closeDb(db);
});

test('belief: explicit supersedes with wrong topic throws', () => {
  const db = freshDb();
  const a = believe(db, null, { topic: 'a', claim: 'x', date: '2026-05-23' });
  assert.throws(() =>
    believe(db, null, { topic: 'b', claim: 'y', supersedes: a.eventId, date: '2026-05-23' }),
  );
  closeDb(db);
});

test('belief: enumerate latest per topic', () => {
  const db = freshDb();
  believe(db, null, { topic: 'a', claim: 'a1', date: '2026-05-23' });
  believe(db, null, { topic: 'b', claim: 'b1', date: '2026-05-23' });
  believe(db, null, { topic: 'a', claim: 'a2', date: '2026-05-24' });
  const all = recallBelief(db, {}) as any[];
  assert.equal(all.length, 2);
  const a = all.find((x) => x.topic === 'a');
  assert.equal(a.claim, 'a2');
  closeDb(db);
});

test('belief: retraction becomes head', () => {
  const db = freshDb();
  believe(db, null, { topic: 't', claim: 'real', date: '2026-05-23' });
  believe(db, null, { topic: 't', claim: 'no longer', retracted: true, date: '2026-05-24' });
  const cur = recallBelief(db, { topic: 't' }) as any;
  assert.equal(cur.retracted, true);
  closeDb(db);
});
