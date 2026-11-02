import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeDb, openDb } from '../../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../../brain/memory/migrations/index.ts';
import { vecIndexSyncedInvariant } from './vec-index-synced.ts';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'robin-vecinv-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

// events_vec is int8[3072] after migration 023. The invariant only compares
// COUNT(embedding NOT NULL) vs COUNT(events_vec), so the stored values are immaterial —
// events_content.embedding gets a 1-byte sentinel (its production form) and the index row
// gets a constant int8 vector.
const INT8_VEC_JSON = JSON.stringify(new Array(3072).fill(1));

function addContent(db: ReturnType<typeof freshDb>, id: number, withVec: boolean) {
  db.prepare(
    `INSERT INTO events_content (id, ts, body, embedding) VALUES (?, datetime('now'), ?, ?)`,
  ).run(id, `body ${id}`, Buffer.from([1]));
  if (withVec) {
    db.prepare(`INSERT INTO events_vec(rowid, embedding) VALUES (?, vec_int8(?))`).run(
      BigInt(id),
      INT8_VEC_JSON,
    );
  }
}

test('vec.index_synced: passes when every embedded row is indexed', () => {
  const db = freshDb();
  for (let i = 1; i <= 20; i++) addContent(db, i, true);
  const r = vecIndexSyncedInvariant(db).check() as { ok: boolean };
  assert.equal(r.ok, true);
  closeDb(db);
});

test('vec.index_synced: passes when content has no embeddings yet (nothing to index)', () => {
  const db = freshDb();
  db.prepare(`INSERT INTO events_content (id, ts, body) VALUES (1, datetime('now'), 'x')`).run();
  const r = vecIndexSyncedInvariant(db).check() as { ok: boolean };
  assert.equal(r.ok, true);
  closeDb(db);
});

test('vec.index_synced: fails when embedded rows are missing from the vec index', () => {
  const db = freshDb();
  // 100 embedded content rows, but only 5 indexed → large drift (the historical bug).
  for (let i = 1; i <= 100; i++) addContent(db, i, i <= 5);
  const r = vecIndexSyncedInvariant(db).check() as {
    ok: boolean;
    message?: string;
    remediation?: string;
  };
  assert.equal(r.ok, false);
  assert.match(r.message ?? '', /vec/i);
  assert.match(r.remediation ?? '', /reindex/);
  closeDb(db);
});

test('vec.index_synced: tolerates a small transient gap (mid-backfill)', () => {
  const db = freshDb();
  // 200 embedded, 199 indexed — one row briefly behind. Should NOT flag.
  for (let i = 1; i <= 200; i++) addContent(db, i, i !== 200);
  const r = vecIndexSyncedInvariant(db).check() as { ok: boolean };
  assert.equal(r.ok, true);
  closeDb(db);
});
