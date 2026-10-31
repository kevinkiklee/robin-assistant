import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import Database from 'better-sqlite3';
import { createKvStore } from './kv.ts';

const SCHEMA = `CREATE TABLE integration_state (
  integration_name TEXT NOT NULL,
  key              TEXT NOT NULL,
  value            TEXT NOT NULL,
  updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (integration_name, key)
);`;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) if (existsSync(d)) rmSync(d, { recursive: true, force: true });
});

function fileDb() {
  const dir = mkdtempSync(join(tmpdir(), 'kvlock-'));
  dirs.push(dir);
  const db = new Database(join(dir, 'robin.sqlite'));
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  return join(dir, 'robin.sqlite');
}

test('acquireLock: a second DB connection is denied while the lease is held', () => {
  const path = fileDb();
  // Two independent connections stand in for the daemon and the MCP process.
  const a = createKvStore(new Database(path), 'whoop');
  const b = createKvStore(new Database(path), 'whoop');
  const now = 1_000_000;
  assert.equal(a.acquireLock!('refresh_lock', 20_000, now), true);
  assert.equal(b.acquireLock!('refresh_lock', 20_000, now), false);
});

test('acquireLock: lease can be taken over only after it expires', () => {
  const db = new Database(fileDb());
  const a = createKvStore(db, 'whoop');
  const now = 1_000_000;
  assert.equal(a.acquireLock!('refresh_lock', 20_000, now), true);
  assert.equal(a.acquireLock!('refresh_lock', 20_000, now + 19_999), false); // still held
  assert.equal(a.acquireLock!('refresh_lock', 20_000, now + 20_000), true); // expired -> takeover
});

test('releaseLock: frees the lease for the next caller immediately', () => {
  const db = new Database(fileDb());
  const a = createKvStore(db, 'whoop');
  const now = 1_000_000;
  assert.equal(a.acquireLock!('refresh_lock', 20_000, now), true);
  a.releaseLock!('refresh_lock');
  assert.equal(a.acquireLock!('refresh_lock', 20_000, now), true);
});

test('acquireLock: leases are scoped per integration', () => {
  const db = new Database(fileDb());
  const whoop = createKvStore(db, 'whoop');
  const spotify = createKvStore(db, 'spotify');
  const now = 1_000_000;
  assert.equal(whoop.acquireLock!('refresh_lock', 20_000, now), true);
  assert.equal(spotify.acquireLock!('refresh_lock', 20_000, now), true); // independent lease
});

test('acquireLock: the lock row does not shadow ordinary get()', () => {
  const db = new Database(fileDb());
  const s = createKvStore(db, 'whoop');
  s.acquireLock!('refresh_lock', 20_000, 1_000_000);
  // The lease is stored under its own key; unrelated reads are unaffected.
  assert.equal(s.get('whoop_refresh_token'), null);
  assert.equal(s.get('refresh_lock'), '1020000');
});
