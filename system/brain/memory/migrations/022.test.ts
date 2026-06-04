import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeDb, openDb, type RobinDb } from '../db.ts';
import { ingest } from '../ingest.ts';
import { allMigrations, applyMigrations } from './index.ts';
import { migration022 } from './022-purge-hook-receipts.ts';

function dbWithMigrationsBelow(version: number): RobinDb {
  const dir = mkdtempSync(join(tmpdir(), 'robin-mig022-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(
    db,
    allMigrations.filter((m) => m.version < version),
  );
  return db;
}

test('migration 022 purges invariant.check hook-receipt events, keeps real kinds', () => {
  const db = dbWithMigrationsBelow(22);
  for (let i = 0; i < 5; i++) {
    ingest(db, null, {
      kind: 'invariant.check',
      source: 'http',
      payload: { name: 'hook.session_end', ok: true },
    });
  }
  ingest(db, null, { kind: 'belief.update', source: 'b', content: 'fact' });
  ingest(db, null, { kind: 'daemon.start', source: 'daemon', payload: { version: 'x' } });

  migration022.up(db);

  const inv = db
    .prepare(`SELECT count(*) AS n FROM events WHERE kind = 'invariant.check'`)
    .get() as { n: number };
  assert.equal(inv.n, 0);

  const kept = db
    .prepare(`SELECT count(*) AS n FROM events WHERE kind IN ('belief.update', 'daemon.start')`)
    .get() as { n: number };
  assert.equal(kept.n, 2);
  closeDb(db);
});

test('migration 022 is a no-op on a clean database', () => {
  const db = dbWithMigrationsBelow(22);
  migration022.up(db);
  const n = db.prepare(`SELECT count(*) AS n FROM events`).get() as { n: number };
  assert.equal(n.n, 0);
  closeDb(db);
});
