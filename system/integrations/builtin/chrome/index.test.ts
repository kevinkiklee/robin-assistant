import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { openDb, closeDb } from '../../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../../brain/memory/migrations/index.ts';
import { buildContext } from '../../_runtime/context.ts';
import { integration as chrome, actions } from './index.ts';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'robin-chr-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

/** Build a fake Chrome History sqlite file with the minimum tables for our query. */
function makeFakeChromeHistory(): string {
  const dir = mkdtempSync(join(tmpdir(), 'robin-fake-chrome-'));
  const path = join(dir, 'History');
  const db = new Database(path);
  db.exec(`
    CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT NOT NULL, title TEXT, visit_count INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE visits (id INTEGER PRIMARY KEY, url INTEGER NOT NULL, visit_time INTEGER NOT NULL);
  `);
  const chromeNow = Date.now() * 1000 + 11644473600_000_000;
  db.prepare(`INSERT INTO urls (id, url, title, visit_count) VALUES (?, ?, ?, ?)`).run(1, 'https://example.com', 'Example', 3);
  db.prepare(`INSERT INTO urls (id, url, title, visit_count) VALUES (?, ?, ?, ?)`).run(2, 'https://wikipedia.org', 'Wikipedia', 5);
  db.prepare(`INSERT INTO visits (url, visit_time) VALUES (?, ?)`).run(1, chromeNow - 1000);
  db.prepare(`INSERT INTO visits (url, visit_time) VALUES (?, ?)`).run(2, chromeNow);
  db.close();
  return path;
}

test('chrome: health is unhealthy when history path does not exist', async () => {
  const db = freshDb();
  const ctx = buildContext('chrome', db, null);
  ctx.state.set('history_path', '/nonexistent/Chrome/History');
  const h = await chrome.health!(ctx);
  assert.equal(h.ok, false);
  closeDb(db);
});

test('chrome: tick reads visits from fake history and ingests them', async () => {
  const db = freshDb();
  const ctx = buildContext('chrome', db, null);
  ctx.state.set('history_path', makeFakeChromeHistory());
  const r = await chrome.tick!(ctx);
  assert.equal(r.status, 'ok');
  assert.equal(r.ingested, 2);
  const rows = db.prepare("SELECT body FROM events_content WHERE body LIKE '%example.com%' OR body LIKE '%wikipedia%'").all();
  assert.equal(rows.length, 2);
  closeDb(db);
});

test('chrome: subsequent tick respects last_sync_micros and returns only newer visits', async () => {
  const db = freshDb();
  const ctx = buildContext('chrome', db, null);
  ctx.state.set('history_path', makeFakeChromeHistory());
  await chrome.tick!(ctx);
  const r2 = await chrome.tick!(ctx);
  assert.equal(r2.ingested, 0);
  closeDb(db);
});

test('chrome: actions.recent_visits returns all visits', async () => {
  const db = freshDb();
  const ctx = buildContext('chrome', db, null);
  ctx.state.set('history_path', makeFakeChromeHistory());
  const visits = await actions.recent_visits({ limit: 10 }, ctx);
  assert.equal(visits.length, 2);
  closeDb(db);
});
