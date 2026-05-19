import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb, closeDb } from '../memory/db.ts';
import { allMigrations, applyMigrations } from '../memory/migrations/index.ts';
import { runDream } from './dream.ts';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'robin-dream-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

test('dream: resolves overdue predictions as unverifiable', async () => {
  const db = freshDb();
  const yesterday = new Date(Date.now() - 86400 * 1000).toISOString();
  db.prepare(`INSERT INTO predictions (claim, confidence, deadline) VALUES (?, ?, ?)`).run(
    'it will rain',
    0.7,
    yesterday,
  );
  const r = await runDream(db, null);
  assert.equal(r.predictionsResolved, 1);
  const row = db.prepare(`SELECT outcome FROM predictions LIMIT 1`).get() as { outcome: string };
  assert.equal(row.outcome, 'unverifiable');
  closeDb(db);
});

test('dream: generates a journal for today', async () => {
  const db = freshDb();
  await runDream(db, null);
  const day = new Date().toISOString().slice(0, 10);
  const row = db.prepare(`SELECT body FROM journals WHERE day = ?`).get(day) as { body: string };
  assert.ok(row);
  assert.match(row.body, /Robin Journal/);
  closeDb(db);
});

test('dream: writes metrics_daily counts', async () => {
  const db = freshDb();
  await runDream(db, null);
  const day = new Date().toISOString().slice(0, 10);
  const rows = db.prepare(`SELECT metric, value FROM metrics_daily WHERE day = ?`).all(day) as Array<{
    metric: string;
    value: number;
  }>;
  const metrics = new Set(rows.map((r) => r.metric));
  assert.ok(metrics.has('events_count'));
  assert.ok(metrics.has('captures_count'));
  assert.ok(metrics.has('corrections_count'));
  closeDb(db);
});
