import assert from 'node:assert/strict';
import { mkdtempSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { dbWalSizeBoundedInvariant } from './db-wal-size-bounded.ts';

function tmpDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'robin-wal-')), 'test.sqlite');
}

function openWalDb(path: string) {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, blob TEXT)');
  return db;
}

test('db.wal_size_bounded: small WAL → ok', async () => {
  const path = tmpDbPath();
  const db = openWalDb(path);
  db.prepare('INSERT INTO t (blob) VALUES (?)').run('x');
  const r = await dbWalSizeBoundedInvariant(db).check();
  assert.equal(r.ok, true, JSON.stringify(r));
  db.close();
});

test('db.wal_size_bounded: check does NOT throw on a read-only connection (regression)', async () => {
  // Write some data so a -wal file exists, then reopen read-only. The old
  // implementation ran `PRAGMA wal_checkpoint(PASSIVE)` in check(), which
  // throws "attempt to write a readonly database" here. The fix stats the
  // -wal file instead, so the check must stay read-only and succeed.
  const path = tmpDbPath();
  const writer = openWalDb(path);
  writer.prepare('INSERT INTO t (blob) VALUES (?)').run('y');
  writer.close();

  const ro = new Database(path, { readonly: true });
  const r = await dbWalSizeBoundedInvariant(ro).check();
  assert.equal(r.ok, true, JSON.stringify(r));
  ro.close();
});

test('db.wal_size_bounded: missing -wal file → ok (0 bytes)', async () => {
  const path = tmpDbPath();
  const db = openWalDb(path);
  // Checkpoint + truncate so no -wal data remains, then force the file empty.
  db.pragma('wal_checkpoint(TRUNCATE)');
  try {
    truncateSync(`${path}-wal`, 0);
  } catch {
    // file may already be gone; either way the check should report ok
  }
  const r = await dbWalSizeBoundedInvariant(db).check();
  assert.equal(r.ok, true, JSON.stringify(r));
  db.close();
});
