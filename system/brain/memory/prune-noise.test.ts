import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeDb, openDb, type RobinDb } from './db.ts';
import { ingest } from './ingest.ts';
import { allMigrations, applyMigrations } from './migrations/index.ts';
import { pruneNoiseVectors, rebuildVecIndex } from './prune-noise.ts';
import { quantizeToInt8Json } from './vec-quantize.ts';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'robin-prune-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

/** events_vec is still float[3072] before migration 023 — the context rebuildVecIndex runs in. */
function freshDbBelow23() {
  const dir = mkdtempSync(join(tmpdir(), 'robin-prune-f-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(
    db,
    allMigrations.filter((m) => m.version < 23),
  );
  return db;
}

/** Simulate an embedded row: sentinel in events_content.embedding + an int8 vec0 index row. */
function fakeEmbed(db: RobinDb, contentId: number) {
  const v = new Array(3072).fill(0.05);
  db.prepare(`UPDATE events_content SET embedding = ? WHERE id = ?`).run(
    Buffer.from([1]),
    contentId,
  );
  db.prepare(`INSERT INTO events_vec(rowid, embedding) VALUES (?, vec_int8(?))`).run(
    BigInt(contentId),
    quantizeToInt8Json(v),
  );
}

function embedded(db: RobinDb, contentId?: number): boolean {
  const r = db
    .prepare(`SELECT embedding IS NOT NULL AS e FROM events_content WHERE id = ?`)
    .get(contentId) as { e: number };
  return r.e === 1;
}
function hasVec(db: RobinDb, rowid?: number): boolean {
  const r = db.prepare(`SELECT count(*) AS n FROM events_vec WHERE rowid = ?`).get(rowid) as {
    n: number;
  };
  return r.n > 0;
}

test('pruneNoiseVectors drops vectors + nulls embedding for denied kinds only', () => {
  const db = freshDb();
  const keep = ingest(db, null, { kind: 'knowledge.doc', source: 's', content: 'note' });
  const denyTxn = ingest(db, null, { kind: 'lunch_money.transaction', source: 's', content: 'c' });
  const denyTick = ingest(db, null, { kind: 'integration.tick', source: 's', content: 'ok' });
  for (const c of [keep, denyTxn, denyTick]) fakeEmbed(db, c.contentId as number);

  const res = pruneNoiseVectors(db);

  assert.equal(res.deletedVectors, 2);
  assert.equal(res.nulledContent, 2);

  // Kept row untouched.
  assert.equal(embedded(db, keep.contentId), true);
  assert.equal(hasVec(db, keep.contentId), true);
  // Denied rows: embedding nulled + vec gone.
  assert.equal(embedded(db, denyTxn.contentId), false);
  assert.equal(hasVec(db, denyTxn.contentId), false);
  assert.equal(embedded(db, denyTick.contentId), false);
  assert.equal(hasVec(db, denyTick.contentId), false);
  closeDb(db);
});

test('pruneNoiseVectors is idempotent (re-run finds nothing)', () => {
  const db = freshDb();
  const deny = ingest(db, null, { kind: 'spotify_played', source: 's', content: 'song' });
  fakeEmbed(db, deny.contentId as number);

  assert.equal(pruneNoiseVectors(db).deletedVectors, 1);
  const second = pruneNoiseVectors(db);
  assert.equal(second.deletedVectors, 0);
  assert.equal(second.nulledContent, 0);
  closeDb(db);
});

test('rebuildVecIndex preserves every vector at its rowid and keeps it searchable', () => {
  // rebuildVecIndex operates on the float[3072] events_vec (migration 021 era), so build
  // the DB up to just before migration 023 converts the table to int8.
  const db = freshDbBelow23();
  const a = ingest(db, null, { kind: 'knowledge.doc', source: 's', content: 'a' });
  const b = ingest(db, null, { kind: 'belief.update', source: 's', content: 'b' });
  // Two distinct unit vectors (one-hot on dims 0 and 1) so MATCH can tell them apart.
  const oneHot = (i: number) =>
    Buffer.from(new Float32Array(new Array(3072).fill(0).map((_, k) => (k === i ? 1 : 0))).buffer);
  const insVec = db.prepare(`INSERT INTO events_vec(rowid, embedding) VALUES (?, ?)`);
  insVec.run(BigInt(a.contentId as number), oneHot(0));
  insVec.run(BigInt(b.contentId as number), oneHot(1));

  const moved = rebuildVecIndex(db);
  assert.equal(moved, 2);

  const n = (db.prepare(`SELECT count(*) AS n FROM events_vec`).get() as { n: number }).n;
  assert.equal(n, 2);

  // Each vector is still findable at its original rowid, distance ~0 to itself.
  const hitA = db
    .prepare(`SELECT rowid, distance FROM events_vec WHERE embedding MATCH ? AND k = 1`)
    .get(oneHot(0)) as { rowid: number; distance: number };
  assert.equal(hitA.rowid, a.contentId);
  assert.ok(hitA.distance < 1e-6, `expected ~0 distance, got ${hitA.distance}`);
  const hitB = db
    .prepare(`SELECT rowid, distance FROM events_vec WHERE embedding MATCH ? AND k = 1`)
    .get(oneHot(1)) as { rowid: number; distance: number };
  assert.equal(hitB.rowid, b.contentId);
  closeDb(db);
});

test('pruneNoiseVectors leaves the vec index synced with embedding sentinels', () => {
  const db = freshDb();
  const keep = ingest(db, null, { kind: 'belief.update', source: 's', content: 'fact' });
  const deny = ingest(db, null, {
    kind: 'lunch_money.account_snapshot',
    source: 's',
    content: 's',
  });
  for (const c of [keep, deny]) fakeEmbed(db, c.contentId as number);

  pruneNoiseVectors(db);

  // vec-index-synced invariant: count(embedding NOT NULL) === count(events_vec).
  const nEmb = db
    .prepare(`SELECT count(*) AS n FROM events_content WHERE embedding IS NOT NULL`)
    .get() as { n: number };
  const nVec = db.prepare(`SELECT count(*) AS n FROM events_vec`).get() as { n: number };
  assert.equal(nEmb.n, nVec.n);
  closeDb(db);
});
