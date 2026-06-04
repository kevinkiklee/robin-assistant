import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeDb, openDb, type RobinDb } from '../db.ts';
import { ingest } from '../ingest.ts';
import { int8DistanceToFloat, quantizeToInt8Json } from '../vec-quantize.ts';
import { allMigrations, applyMigrations } from './index.ts';
import { migration023 } from './023-events-vec-int8.ts';

function dbWithMigrationsBelow(version: number): RobinDb {
  const dir = mkdtempSync(join(tmpdir(), 'robin-mig023-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(
    db,
    allMigrations.filter((m) => m.version < version),
  );
  return db;
}

function oneHot(i: number): Float32Array {
  const v = new Float32Array(3072);
  v[i] = 0.2; // realistic component magnitude
  return v;
}

test('migration 023 converts events_vec float->int8, preserving searchability + rowids', () => {
  const db = dbWithMigrationsBelow(23);
  const c1 = ingest(db, null, { kind: 'knowledge.doc', source: 's', content: 'a' });
  const c2 = ingest(db, null, { kind: 'belief.update', source: 's', content: 'b' });
  // events_vec is float[3072] at this point — insert raw float blobs.
  const insF = db.prepare(`INSERT INTO events_vec(rowid, embedding) VALUES (?, ?)`);
  insF.run(BigInt(c1.contentId as number), Buffer.from(oneHot(0).buffer));
  insF.run(BigInt(c2.contentId as number), Buffer.from(oneHot(1).buffer));

  migration023.up(db);

  // Count preserved.
  const n = (db.prepare(`SELECT count(*) AS n FROM events_vec`).get() as { n: number }).n;
  assert.equal(n, 2);

  // Now an int8 table: a vec_int8 query finds the matching rowid at ~0 distance.
  const hit = db
    .prepare(`SELECT rowid, distance FROM events_vec WHERE embedding MATCH vec_int8(?) AND k = 1`)
    .get(quantizeToInt8Json(oneHot(0))) as { rowid: number; distance: number };
  assert.equal(hit.rowid, c1.contentId);
  assert.ok(int8DistanceToFloat(hit.distance) < 0.02, `self-distance too large: ${hit.distance}`);

  // A float-blob query should now FAIL (table is int8) — proves the type really changed.
  assert.throws(() => {
    db.prepare(`SELECT rowid FROM events_vec WHERE embedding MATCH ? AND k = 1`).get(
      Buffer.from(oneHot(0).buffer),
    );
  });
  closeDb(db);
});

test('migration 023 is a no-op on an empty database', () => {
  const db = dbWithMigrationsBelow(23);
  migration023.up(db);
  const n = (db.prepare(`SELECT count(*) AS n FROM events_vec`).get() as { n: number }).n;
  assert.equal(n, 0);
  closeDb(db);
});
