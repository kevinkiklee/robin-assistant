import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { believe, recallBelief } from './belief.ts';
import { type CanonicalizeResult, canonicalizeBeliefHeads } from './canonicalize-heads.ts';
import { closeDb, openDb } from './db.ts';
import { ingest } from './ingest.ts';
import { allMigrations, applyMigrations } from './migrations/index.ts';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'robin-canonical-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

test('canonicalize-heads: groups live heads by canonical slug and merges similar-claim groups onto newest head', () => {
  const db = freshDb();

  // Three live heads with near-identical claims.
  // 'aerospace-internship' (oldest), 'no-aerospace-internship', 'aerospace-internship-claim' (newest).
  // All three canonicalize to 'aerospace-internship'.
  // We use different dates so believe() keeps all three as separate heads stored under
  // different topics (the cross-slug gate allows the negated/modifier slugs to merge
  // at write time if claims are similar — use ingest() directly for the two legacy heads
  // to simulate pre-C1 data sitting under non-canonical slugs).
  ingest(db, null, {
    kind: 'belief.update',
    source: 'belief',
    content: 'Kevin has an aerospace internship',
    payload: {
      topic: 'aerospace-internship',
      supersedes: null,
      confidence: 0.8,
      sources: [],
      retracted: false,
      provenance: 'unknown',
      verified_at: '2026-06-01T00:00:00.000Z',
      external_id: 'belief:2026-06-01:aerospace-internship',
    },
  });
  ingest(db, null, {
    kind: 'belief.update',
    source: 'belief',
    content: 'Kevin has an aerospace internship at SpaceX',
    payload: {
      topic: 'no-aerospace-internship',
      supersedes: null,
      confidence: 0.85,
      sources: [],
      retracted: false,
      provenance: 'unknown',
      verified_at: '2026-06-05T00:00:00.000Z',
      external_id: 'belief:2026-06-05:no-aerospace-internship',
    },
  });
  ingest(db, null, {
    kind: 'belief.update',
    source: 'belief',
    content: 'Kevin has an aerospace internship confirmed',
    payload: {
      topic: 'aerospace-internship-claim',
      supersedes: null,
      confidence: 0.9,
      sources: [],
      retracted: false,
      provenance: 'unknown',
      verified_at: '2026-06-10T00:00:00.000Z',
      external_id: 'belief:2026-06-10:aerospace-internship-claim',
    },
  });

  // Dry run should not write anything.
  const dryResult: CanonicalizeResult = canonicalizeBeliefHeads(db, null, { apply: false });
  assert.equal(dryResult.groups, 1, 'one multi-head group');
  assert.equal(dryResult.merged, 1, 'one group would merge (dry-run counts it)');
  assert.equal(dryResult.skipped, 0);
  const dryEventCount = (
    db.prepare(`SELECT COUNT(*) AS n FROM events WHERE kind='belief.canonicalize'`).get() as {
      n: number;
    }
  ).n;
  assert.equal(dryEventCount, 0, 'dry-run writes zero events');

  // Apply.
  const result: CanonicalizeResult = canonicalizeBeliefHeads(db, null, { apply: true });
  assert.equal(result.groups, 1);
  assert.equal(result.merged, 1);
  assert.equal(result.skipped, 0);

  // After apply there should be exactly one live head for the canonical topic.
  const all = recallBelief(db, {}) as import('./belief.ts').BeliefRecord[];
  const aerospaceHeads = all.filter((h) => h.topic === 'aerospace-internship');
  assert.equal(aerospaceHeads.length, 1, 'exactly one live head for the canonical topic');

  // Superseding events should carry canonicalize:-prefixed external_ids.
  const canonicalEvents = db
    .prepare(
      `SELECT json_extract(payload,'$.external_id') AS eid FROM events WHERE kind='belief.update' AND json_extract(payload,'$.external_id') LIKE 'canonicalize:%'`,
    )
    .all() as Array<{ eid: string }>;
  assert.ok(
    canonicalEvents.length >= 2,
    `expected >=2 superseding events, got ${canonicalEvents.length}`,
  );
  for (const e of canonicalEvents) {
    assert.ok(
      e.eid.startsWith('canonicalize:'),
      `external_id should start with canonicalize: got ${e.eid}`,
    );
  }

  // Audit events written.
  const auditCount = (
    db.prepare(`SELECT COUNT(*) AS n FROM events WHERE kind='belief.canonicalize'`).get() as {
      n: number;
    }
  ).n;
  assert.ok(auditCount >= 1, 'at least one belief.canonicalize audit event');

  closeDb(db);
});

test('canonicalize-heads: dissimilar-claim groups are skipped and logged, not merged', () => {
  const db = freshDb();

  // Two heads whose slugs canonicalize together but claims are entirely unrelated.
  ingest(db, null, {
    kind: 'belief.update',
    source: 'belief',
    content: 'Kevin drinks two espressos every morning',
    payload: {
      topic: 'coffee',
      supersedes: null,
      confidence: null,
      sources: [],
      retracted: false,
      provenance: 'unknown',
      verified_at: '2026-06-01T00:00:00.000Z',
      external_id: 'belief:2026-06-01:coffee',
    },
  });
  ingest(db, null, {
    kind: 'belief.update',
    source: 'belief',
    content:
      'The Chemex carafe cracked and was thrown out yesterday after being dropped on the kitchen floor during cleanup',
    payload: {
      topic: 'coffee-status',
      supersedes: null,
      confidence: null,
      sources: [],
      retracted: false,
      provenance: 'unknown',
      verified_at: '2026-06-05T00:00:00.000Z',
      external_id: 'belief:2026-06-05:coffee-status',
    },
  });

  const result: CanonicalizeResult = canonicalizeBeliefHeads(db, null, { apply: true });
  assert.equal(result.skipped, 1, 'one group skipped as dissimilar');
  assert.equal(result.merged, 0);

  // Both heads should still be live.
  const all = recallBelief(db, {}) as import('./belief.ts').BeliefRecord[];
  const coffeeHeads = all.filter((h) => h.topic === 'coffee' || h.topic === 'coffee-status');
  assert.equal(coffeeHeads.length, 2, 'both distinct heads remain live');

  // A belief.canonicalize audit event with decision:'skipped-dissimilar' must exist.
  const audit = db
    .prepare(
      `SELECT json_extract(payload,'$.decision') AS d FROM events WHERE kind='belief.canonicalize'`,
    )
    .all() as Array<{ d: string }>;
  assert.ok(
    audit.some((a) => a.d === 'skipped-dissimilar'),
    'audit event with decision:skipped-dissimilar expected',
  );

  closeDb(db);
});

test('canonicalize-heads: dry-run writes nothing', () => {
  const db = freshDb();

  // Two mergeable heads.
  ingest(db, null, {
    kind: 'belief.update',
    source: 'belief',
    content: 'Kevin has an aerospace internship',
    payload: {
      topic: 'aerospace-internship',
      supersedes: null,
      confidence: null,
      sources: [],
      retracted: false,
      provenance: 'unknown',
      verified_at: '2026-06-01T00:00:00.000Z',
      external_id: 'belief:2026-06-01:aerospace-internship',
    },
  });
  ingest(db, null, {
    kind: 'belief.update',
    source: 'belief',
    content: 'Kevin has an aerospace internship at SpaceX',
    payload: {
      topic: 'aerospace-internship-claim',
      supersedes: null,
      confidence: null,
      sources: [],
      retracted: false,
      provenance: 'unknown',
      verified_at: '2026-06-05T00:00:00.000Z',
      external_id: 'belief:2026-06-05:aerospace-internship-claim',
    },
  });

  const beforeCount = (db.prepare(`SELECT COUNT(*) AS n FROM events`).get() as { n: number }).n;
  const result: CanonicalizeResult = canonicalizeBeliefHeads(db, null, { apply: false });
  const afterCount = (db.prepare(`SELECT COUNT(*) AS n FROM events`).get() as { n: number }).n;

  assert.equal(afterCount, beforeCount, 'dry-run must write zero new event rows');
  assert.equal(result.merged, 1, 'dry-run still reports the planned merge count');
  assert.equal(result.skipped, 0);

  closeDb(db);
});

test('canonicalize-heads: idempotent — a second apply run is a no-op', () => {
  const db = freshDb();

  // Seed two mergeable legacy heads.
  ingest(db, null, {
    kind: 'belief.update',
    source: 'belief',
    content: 'Kevin has an aerospace internship',
    payload: {
      topic: 'aerospace-internship',
      supersedes: null,
      confidence: null,
      sources: [],
      retracted: false,
      provenance: 'unknown',
      verified_at: '2026-06-01T00:00:00.000Z',
      external_id: 'belief:2026-06-01:aerospace-internship',
    },
  });
  ingest(db, null, {
    kind: 'belief.update',
    source: 'belief',
    content: 'Kevin has an aerospace internship at SpaceX',
    payload: {
      topic: 'aerospace-internship-claim',
      supersedes: null,
      confidence: null,
      sources: [],
      retracted: false,
      provenance: 'unknown',
      verified_at: '2026-06-05T00:00:00.000Z',
      external_id: 'belief:2026-06-05:aerospace-internship-claim',
    },
  });

  const first = canonicalizeBeliefHeads(db, null, { apply: true });
  assert.equal(first.merged, 1);

  // Second run: the merged heads are no longer live — the group disappears.
  const second = canonicalizeBeliefHeads(db, null, { apply: true });
  assert.equal(second.groups, 0, 'no multi-head groups remain after first apply');
  assert.equal(second.merged, 0);
  assert.equal(second.skipped, 0);

  closeDb(db);
});

test('canonicalize-heads: E2E — duplicate-topic promote writes canonical head; second pass finds nothing to merge', () => {
  const db = freshDb();

  // Post-Task-2, believe() already merges similar cross-slug writes at write time.
  // Two similar claims under slug variants should produce a single live head.
  const a = believe(db, null, {
    topic: 'home-location',
    claim: 'Kevin lives in Hoboken NJ',
    date: '2026-06-01',
  });
  // 'home-location-status' canonicalizes to 'home-location'; claim is similar → believe() merges at write time.
  const b = believe(db, null, {
    topic: 'home-location-status',
    claim: 'Kevin lives in Hoboken New Jersey',
    date: '2026-06-05',
  });
  // The second write should have superseded the first (same canonical slug, similar claim).
  assert.equal(b.supersededEventId, a.eventId, 'write-time canonical supersession worked');
  assert.equal(b.topic, 'home-location');

  // A merge pass finds no multi-head groups (write-time already canonicalized).
  const result = canonicalizeBeliefHeads(db, null, { apply: true });
  assert.equal(
    result.groups,
    0,
    'no groups: write-time canonical merge already collapsed the pair',
  );
  assert.equal(result.merged, 0);

  closeDb(db);
});
