import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeDb, openDb, type RobinDb } from '../db.ts';
import { ingest } from '../ingest.ts';
import { migration021 } from './021-dedup-vectors.ts';
import { allMigrations, applyMigrations } from './index.ts';

function dbWithMigrationsBelow(version: number): RobinDb {
  const dir = mkdtempSync(join(tmpdir(), 'robin-mig021-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(
    db,
    allMigrations.filter((m) => m.version < version),
  );
  return db;
}

function fakeEmbed(db: RobinDb, id: number) {
  const buf = Buffer.from(new Float32Array(new Array(3072).fill(0.1)).buffer);
  db.prepare(`UPDATE events_content SET embedding = ? WHERE id = ?`).run(buf, id);
  db.prepare(`INSERT INTO events_vec(rowid, embedding) VALUES (?, ?)`).run(BigInt(id), buf);
}

test('migration 021 prunes noise vectors and sentinel-izes remaining embeddings', () => {
  const db = dbWithMigrationsBelow(21);
  const keep = ingest(db, null, { kind: 'knowledge.doc', source: 's', content: 'note' });
  const deny = ingest(db, null, { kind: 'lunch_money.transaction', source: 's', content: 'c' });
  for (const c of [keep, deny]) fakeEmbed(db, c.contentId as number);

  migration021.up(db);

  // Noise row pruned: embedding nulled, vec gone.
  const denyEmb = db
    .prepare(`SELECT embedding FROM events_content WHERE id = ?`)
    .get(deny.contentId) as { embedding: unknown };
  assert.equal(denyEmb.embedding, null);
  const denyVec = db
    .prepare(`SELECT count(*) AS n FROM events_vec WHERE rowid = ?`)
    .get(deny.contentId) as { n: number };
  assert.equal(denyVec.n, 0);

  // Remaining embeddable row: full vector compressed to a 1-byte sentinel.
  const keepLen = db
    .prepare(`SELECT length(embedding) AS len FROM events_content WHERE id = ?`)
    .get(keep.contentId) as { len: number };
  assert.equal(keepLen.len, 1);

  // vec.index_synced invariant holds: count(embedding NOT NULL) === count(events_vec).
  const nEmb = db
    .prepare(`SELECT count(*) AS n FROM events_content WHERE embedding IS NOT NULL`)
    .get() as { n: number };
  const nVec = db.prepare(`SELECT count(*) AS n FROM events_vec`).get() as { n: number };
  assert.equal(nEmb.n, nVec.n);
  assert.equal(nVec.n, 1);
  closeDb(db);
});

test('migration 021 is a no-op on a fresh (empty) database', () => {
  const db = dbWithMigrationsBelow(21);
  migration021.up(db); // must not throw
  const n = db.prepare(`SELECT count(*) AS n FROM events_content`).get() as { n: number };
  assert.equal(n.n, 0);
  closeDb(db);
});
