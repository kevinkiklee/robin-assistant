import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  type BeliefRecord,
  believe,
  canonicalizeTopic,
  normalizeTopic,
  recallBelief,
} from './belief.ts';
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
  assert.equal((b as BeliefRecord).claim, 'dips after redeye');
  closeDb(db);
});

test('belief: normalize collides _ and - and case', () => {
  assert.equal(normalizeTopic('Whoop.Recovery_X'), normalizeTopic('whoop.recovery-x'));
});

test('canonicalizeTopic strips negation and modifier tokens', () => {
  const cases: Array<[string, string]> = [
    ['no-aerospace-internship', 'aerospace-internship'],
    ['aerospace-internship-claim', 'aerospace-internship'],
    ['aerospace-internship-status', 'aerospace-internship'],
    ['not-moving-to-sf', 'moving-to-sf'],
    ['kevins-current-employer', 'employer'],
    ['medications-ramelteon', 'medications-ramelteon'], // no stopwords → unchanged
    ['home-location', 'home-location'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(canonicalizeTopic(input), expected, input);
  }
});

test('canonicalizeTopic never returns empty — all-stopword slugs fall back to the input', () => {
  assert.equal(canonicalizeTopic('no-claim'), 'no-claim');
  assert.equal(canonicalizeTopic('current-status'), 'current-status');
});

test('canonicalizeTopic is idempotent', () => {
  const once = canonicalizeTopic('no-aerospace-internship-claim');
  assert.equal(canonicalizeTopic(once), once);
});

test('belief: opposing claim under a negated slug supersedes the same head', () => {
  const db = freshDb();
  const a = believe(db, null, {
    topic: 'aerospace-internship',
    claim: 'Kevin has an aerospace internship',
    date: '2026-06-10',
  });
  const b = believe(db, null, {
    topic: 'no-aerospace-internship',
    claim: 'Kevin does not have an aerospace internship',
    date: '2026-06-11',
  });
  assert.equal(b.supersededEventId, a.eventId); // one chain, not two heads
  assert.equal(b.topic, 'aerospace-internship'); // stored canonical
  closeDb(db);
});

test('belief: modifier slug variant supersedes the canonical head', () => {
  const db = freshDb();
  const a = believe(db, null, {
    topic: 'sf-move',
    claim: 'Kevin is moving to SF in July',
    date: '2026-06-10',
  });
  const b = believe(db, null, {
    topic: 'sf-move-status',
    claim: 'Kevin is moving to SF in August',
    date: '2026-06-11',
  });
  assert.equal(b.supersededEventId, a.eventId);
  closeDb(db);
});

test('belief: slug collision with dissimilar claim does NOT merge — falls back to plain-normalized topic', () => {
  const db = freshDb();
  const a = believe(db, null, {
    topic: 'coffee',
    claim: 'Kevin drinks two espressos every morning',
    date: '2026-06-10',
  });
  // 'coffee-status' canonicalizes to 'coffee' but the claim is unrelated text:
  const b = believe(db, null, {
    topic: 'coffee-status',
    claim: 'The Chemex carafe cracked and was thrown out yesterday',
    date: '2026-06-11',
  });
  assert.equal(b.supersededEventId, null);
  assert.equal(b.topic, 'coffee-status'); // kept distinct — false merges are worse than duplicates
  assert.notEqual(b.eventId, a.eventId);
  closeDb(db);
});

test('belief: same stored topic always supersedes regardless of claim text (existing contract)', () => {
  const db = freshDb();
  const a = believe(db, null, {
    topic: 'coffee',
    claim: 'Kevin drinks two espressos every morning',
    date: '2026-06-10',
  });
  const b = believe(db, null, {
    topic: 'coffee',
    claim: 'Completely different text about coffee gear',
    date: '2026-06-11',
  });
  assert.equal(b.supersededEventId, a.eventId);
  closeDb(db);
});

test('belief: explicit supersedes bypasses the similarity gate (retraction path)', () => {
  const db = freshDb();
  const a = believe(db, null, {
    topic: 'no-aerospace-internship',
    claim: 'Kevin does not have an aerospace internship',
    date: '2026-06-10',
  });
  const r = believe(db, null, {
    topic: 'aerospace-internship',
    claim: '(retracted)',
    retracted: true,
    supersedes: a.eventId,
    date: '2026-06-11',
  });
  assert.equal(r.supersededEventId, a.eventId); // canonical-form topic match, no similarity check
  closeDb(db);
});

test('belief: canonicalized writes carry original_topic in the payload', () => {
  const db = freshDb();
  const b = believe(db, null, {
    topic: 'no-aerospace-internship',
    claim: 'x y z',
    date: '2026-06-11',
  });
  const raw = db
    .prepare(`SELECT json_extract(payload,'$.original_topic') AS o FROM events WHERE id=?`)
    .get(b.eventId) as { o: string | null };
  assert.equal(raw.o, 'no-aerospace-internship');
  closeDb(db);
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
  const cur = recallBelief(db, { topic: 't' }) as BeliefRecord;
  assert.equal(cur.claim, 'v2');
  closeDb(db);
});

test('belief: cross-day write supersedes yesterday', () => {
  const db = freshDb();
  const a = believe(db, null, { topic: 't', claim: 'v1', date: '2026-05-23' });
  const b = believe(db, null, { topic: 't', claim: 'v2', date: '2026-05-24' });
  assert.equal(b.supersededEventId, a.eventId);
  const chain = recallBelief(db, { topic: 't', history: true }) as BeliefRecord[];
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
  const all = recallBelief(db, {}) as BeliefRecord[];
  assert.equal(all.length, 2);
  const a = all.find((x: BeliefRecord) => x.topic === 'a');
  assert.ok(a);
  assert.equal(a.claim, 'a2');
  closeDb(db);
});

test('belief: retraction becomes head', () => {
  const db = freshDb();
  believe(db, null, { topic: 't', claim: 'real', date: '2026-05-23' });
  believe(db, null, { topic: 't', claim: 'no longer', retracted: true, date: '2026-05-24' });
  const cur = recallBelief(db, { topic: 't' }) as BeliefRecord;
  assert.equal(cur.retracted, true);
  closeDb(db);
});

test('belief: believe() blocks dev-artifact claims on the direct write path', () => {
  const db = freshDb();
  const r = believe(db, null, {
    topic: 'robin-integration-count',
    claim: 'Kevin has 17 integrations configured in his Robin assistant instance.',
    date: '2026-06-08',
  });
  assert.equal(r.eventId, -1);
  assert.equal(r.blocked, 'dev-artifact');
  // No row was written — the topic does not exist.
  assert.equal(recallBelief(db, { topic: 'robin-integration-count' }), null);
  const count = db.prepare(`SELECT COUNT(*) c FROM events WHERE kind='belief.update'`).get() as {
    c: number;
  };
  assert.equal(count.c, 0);
  closeDb(db);
});

test('belief: a retraction of a dev-artifact topic is always allowed through', () => {
  const db = freshDb();
  // Even though the claim text is a dev-artifact, retracting it must succeed so
  // existing machinery beliefs stay removable.
  const r = believe(db, null, {
    topic: 'surrealdb-transport',
    claim: 'SurrealDB uses WebSocket for its connection protocol.',
    retracted: true,
    date: '2026-06-08',
  });
  assert.ok(r.eventId > 0);
  assert.equal(r.blocked, undefined);
  const cur = recallBelief(db, { topic: 'surrealdb-transport' }) as BeliefRecord;
  assert.equal(cur.retracted, true);
  closeDb(db);
});

test('belief: enumerate excludes topics whose latest head is retracted', () => {
  const db = freshDb();
  believe(db, null, { topic: 'live', claim: 'still true', date: '2026-05-23' });
  believe(db, null, { topic: 'dead', claim: 'was true', date: '2026-05-23' });
  believe(db, null, { topic: 'dead', claim: 'retracted', retracted: true, date: '2026-05-24' });
  const all = recallBelief(db, {}) as BeliefRecord[];
  const topics = all.map((b) => b.topic);
  assert.ok(topics.includes('live'));
  assert.ok(!topics.includes('dead'), 'retracted topic must not surface in enumerate');
  // The topic is still readable directly (the tombstone is preserved).
  const dead = recallBelief(db, { topic: 'dead' }) as BeliefRecord;
  assert.equal(dead.retracted, true);
  closeDb(db);
});

test('belief: same-day explicit supersede APPENDS, never self-references (append-only)', () => {
  // Regression: a same-day retraction/re-confirm must not collapse onto the row
  // it supersedes via external_id upsert (which produced supersedes===own-id and
  // dropped history). The nightly freshness + corrections-replay passes hit this.
  const db = freshDb();
  const first = believe(db, null, {
    topic: 'kevin.city',
    claim: 'lives in NYC',
    date: '2026-05-25',
  });
  const second = believe(db, null, {
    topic: 'kevin.city',
    claim: 'lives in NYC',
    retracted: true,
    supersedes: first.eventId,
    date: '2026-05-25',
  });
  assert.notEqual(second.eventId, first.eventId);
  const history = recallBelief(db, { topic: 'kevin.city', history: true }) as BeliefRecord[];
  assert.equal(
    history.length,
    2,
    'expected 2 history rows — the supersede appended, did not upsert',
  );
  const head = recallBelief(db, { topic: 'kevin.city' }) as BeliefRecord;
  assert.equal(head.eventId, second.eventId);
  assert.equal(head.supersedes, first.eventId);
  assert.notEqual(head.supersedes, head.eventId);
  assert.equal(head.retracted, true);
  closeDb(db);
});

test('belief: same-day plain re-set still upserts in place (no history pileup)', () => {
  // The append-on-supersede fix must NOT break plain same-day idempotency: two
  // "set" calls (no explicit supersedes) on one topic/day collapse to one row.
  const db = freshDb();
  believe(db, null, { topic: 'mood', claim: 'ok', date: '2026-05-25' });
  believe(db, null, { topic: 'mood', claim: 'great', date: '2026-05-25' });
  const history = recallBelief(db, { topic: 'mood', history: true }) as BeliefRecord[];
  assert.equal(history.length, 1, 'same-day plain re-set should upsert, not append');
  assert.equal(history[0].claim, 'great');
  closeDb(db);
});
