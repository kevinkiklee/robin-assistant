import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { pinSqlClock } from './sql-clock.ts';

const T = Date.parse('2027-03-01T12:00:00Z');

function db() {
  const d = new Database(':memory:');
  let now = T;
  pinSqlClock(d, () => now);
  return {
    d,
    set: (ms: number) => {
      now = ms;
    },
  };
}

test('pinSqlClock: datetime(now), zero-arg, mixed case and modifiers follow the sim clock', () => {
  const { d } = db();
  const row = d
    .prepare(
      `SELECT datetime('now') a, datetime() b, DATETIME('NOW') c, datetime('now','-7 days') e, date('now') f`,
    )
    .get() as Record<string, string>;
  assert.equal(row.a, '2027-03-01 12:00:00');
  assert.equal(row.b, '2027-03-01 12:00:00');
  assert.equal(row.c, '2027-03-01 12:00:00');
  assert.equal(row.e, '2027-02-22 12:00:00');
  assert.equal(row.f, '2027-03-01');
});

test('pinSqlClock: strftime, julianday, unixepoch follow the sim clock', () => {
  const { d } = db();
  const row = d
    .prepare(
      `SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') s, unixepoch('now') u, julianday('now') - julianday('2027-03-01 12:00:00') j`,
    )
    .get() as { s: string; u: number; j: number };
  assert.equal(row.s, '2027-03-01T12:00:00.000Z');
  assert.equal(row.u, T / 1000);
  assert.equal(row.j, 0);
});

test('pinSqlClock: column DEFAULT (datetime(now)) uses the sim clock at insert time', () => {
  const { d, set } = db();
  d.exec(`CREATE TABLE t (id INTEGER PRIMARY KEY, created_at TEXT DEFAULT (datetime('now')))`);
  d.prepare('INSERT INTO t DEFAULT VALUES').run();
  set(T + 10 * 86_400_000);
  d.prepare('INSERT INTO t DEFAULT VALUES').run();
  const rows = d.prepare('SELECT created_at FROM t ORDER BY id').all() as { created_at: string }[];
  assert.deepEqual(
    rows.map((r) => r.created_at),
    ['2027-03-01 12:00:00', '2027-03-11 12:00:00'],
  );
});

test('pinSqlClock: explicit timestamps are untouched', () => {
  const { d } = db();
  const row = d.prepare(`SELECT datetime('2020-01-01 00:00:00','+1 day') v`).get() as { v: string };
  assert.equal(row.v, '2020-01-02 00:00:00');
});

test('pinSqlClock: one-argument strftime and zero-arg time/date/unixepoch follow the sim clock', () => {
  const { d } = db();
  const row = d
    .prepare(`SELECT strftime('%Y') y, strftime('%s') s, time() t, date() dt, unixepoch() u`)
    .get() as { y: string; s: string; t: string; dt: string; u: number };
  assert.equal(row.y, '2027');
  assert.equal(row.s, String(T / 1000));
  assert.equal(row.t, '12:00:00');
  assert.equal(row.dt, '2027-03-01');
  assert.equal(row.u, T / 1000);
});
