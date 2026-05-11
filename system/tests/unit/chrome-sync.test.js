import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { sync } from '../../src/integrations/chrome/sync.js';

let tmpHome;
let chromeDir;
let historyPath;

test.beforeEach(() => {
  tmpHome = join(tmpdir(), `robin-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpHome, { recursive: true });
  process.env.ROBIN_HOME = tmpHome;
  chromeDir = join(tmpHome, 'fixtures');
  mkdirSync(chromeDir, { recursive: true });
  historyPath = join(chromeDir, 'History');
  process.env.CHROME_HISTORY_PATH = historyPath;
  // Build a fixture sqlite with the (subset of) Chrome History schema we read.
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
    'https://github.com/',
    'GitHub',
  );
  // Chrome time = microseconds since 1601-01-01. May 10 2026 00:00 UTC ≈
  // 13_388_083_200_000_000 (epoch offset 11_644_473_600_000_000 + ms*1000).
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
  db.close();
});

test.afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.CHROME_HISTORY_PATH;
  delete process.env.ROBIN_HOME;
});

test('chrome sync captures per-visit events plus a top-domains aggregation', async () => {
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
  assert.equal(r.count, 3); // 2 visits + 1 top_domains aggregation
  const visits = captured.filter((e) => e.meta.kind === 'visit');
  assert.equal(visits.length, 2);
  assert.ok(visits.every((v) => v.external_id.startsWith('chrome:visit:')));
  const tops = captured.filter((e) => e.meta.kind === 'top_domains');
  assert.equal(tops.length, 1);
  assert.match(tops[0].external_id, /^chrome:top_domains:\d{4}-\d{2}-\d{2}$/);
  assert.ok(Array.isArray(tops[0].meta.domains));
  // since_visit_id should advance to the highest id seen.
  assert.equal(r.cursor.since_visit_id, 2);
});

test('chrome sync respects since_visit_id cursor', async () => {
  const captured = [];
  const r = await sync({
    secrets: {},
    log: () => {},
    cursor: { since_visit_id: 1 }, // skip the first visit
    capture: async (rows) => {
      captured.push(...rows);
      return {};
    },
  });
  const visits = captured.filter((e) => e.meta.kind === 'visit');
  assert.equal(visits.length, 1);
  assert.equal(visits[0].meta.visit_id, 2);
  assert.equal(r.cursor.since_visit_id, 2);
});

test('chrome sync emits no top_domains aggregation when no new visits', async () => {
  const captured = [];
  const r = await sync({
    secrets: {},
    log: () => {},
    cursor: { since_visit_id: 999 }, // beyond all visits
    capture: async (rows) => {
      captured.push(...rows);
      return {};
    },
  });
  assert.equal(r.count, 0);
  assert.equal(captured.length, 0);
  assert.equal(r.cursor.since_visit_id, 999);
});
