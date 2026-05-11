import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { sync } from '../../io/integrations/chrome/sync.js';

let tmpHome;
let historyPath;
let snapshotsDir;

test.beforeEach(() => {
  tmpHome = join(tmpdir(), `robin-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpHome, { recursive: true });
  process.env.ROBIN_HOME = tmpHome;
  historyPath = join(tmpHome, 'History');
  process.env.CHROME_HISTORY_PATH = historyPath;
  snapshotsDir = join(tmpHome, 'cache', 'sqlite-snapshots');

  const db = new Database(historyPath);
  db.exec(`
    CREATE TABLE urls (
      id INTEGER PRIMARY KEY,
      url TEXT,
      title TEXT,
      visit_count INTEGER,
      typed_count INTEGER,
      last_visit_time INTEGER,
      hidden INTEGER
    );
    CREATE TABLE visits (
      id INTEGER PRIMARY KEY,
      url INTEGER,
      visit_time INTEGER,
      from_visit INTEGER,
      transition INTEGER,
      segment_id INTEGER,
      visit_duration INTEGER
    );
  `);
  db.prepare('INSERT INTO urls (id, url, title) VALUES (?, ?, ?)').run(
    1,
    'https://example.com/',
    'Example',
  );
  db.prepare('INSERT INTO urls (id, url, title) VALUES (?, ?, ?)').run(
    2,
    'https://github.com/anthropics',
    'Anthropic on GitHub',
  );
  db.prepare('INSERT INTO urls (id, url, title) VALUES (?, ?, ?)').run(
    3,
    'https://news.ycombinator.com/',
    'Hacker News',
  );
  // Chrome time: microseconds since 1601-01-01 UTC.
  // 2026-05-10 00:00 UTC ≈ 13_388_083_200_000_000.
  const t = 13_388_083_200_000_000;
  db.prepare('INSERT INTO visits (id, url, visit_time, transition) VALUES (?, ?, ?, ?)').run(
    1,
    1,
    t,
    0,
  );
  db.prepare('INSERT INTO visits (id, url, visit_time, transition) VALUES (?, ?, ?, ?)').run(
    2,
    2,
    t + 1000,
    0,
  );
  db.prepare('INSERT INTO visits (id, url, visit_time, transition) VALUES (?, ?, ?, ?)').run(
    3,
    3,
    t + 2000,
    0,
  );
  db.close();
});

test.afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.CHROME_HISTORY_PATH;
  delete process.env.ROBIN_HOME;
});

test('chrome end-to-end: copies SQLite to snapshot dir, captures events, removes snapshot', async () => {
  const captured = [];
  const r = await sync({
    secrets: {},
    log: () => {},
    cursor: null,
    capture: async (rows) => {
      captured.push(...rows);
      return {};
    },
  });

  // 3 visits + 1 top_domains aggregation.
  assert.equal(r.count, 4);
  const visits = captured.filter((e) => e.meta.kind === 'visit');
  assert.equal(visits.length, 3);
  // Verify content shape: title surfaced.
  assert.ok(visits.some((v) => /Example/.test(v.content)));
  assert.ok(visits.some((v) => /Anthropic/.test(v.content)));
  // Top-domains event is present.
  const tops = captured.filter((e) => e.meta.kind === 'top_domains');
  assert.equal(tops.length, 1);
  assert.match(tops[0].external_id, /^chrome:top_domains:\d{4}-\d{2}-\d{2}$/);
  // Cursor advances to the highest visit_id seen.
  assert.equal(r.cursor.since_visit_id, 3);
  // Original History file is untouched (still readable).
  assert.ok(existsSync(historyPath), 'source History file remains in place');
  // Snapshot dir is created (the readSqliteSnapshot mkdir'd it) but the
  // copied snapshot file inside has been deleted by the finally block.
  if (existsSync(snapshotsDir)) {
    const remaining = readdirSync(snapshotsDir).filter((f) => f.startsWith('chrome-history-'));
    assert.equal(
      remaining.length,
      0,
      `snapshot files should be removed; still present: ${remaining.join(', ')}`,
    );
  }
});

test('chrome sync respects since_visit_id cursor in end-to-end flow', async () => {
  const captured = [];
  const r = await sync({
    secrets: {},
    log: () => {},
    cursor: { since_visit_id: 2 },
    capture: async (rows) => {
      captured.push(...rows);
      return {};
    },
  });
  const visits = captured.filter((e) => e.meta.kind === 'visit');
  assert.equal(visits.length, 1, 'only visit_id > 2 returned');
  assert.equal(visits[0].meta.visit_id, 3);
  assert.equal(r.cursor.since_visit_id, 3);
});
