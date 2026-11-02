import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeDb, openDb } from '../../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../../brain/memory/migrations/index.ts';
import { preCheck } from './pre-checks.ts';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'robin-pre-checks-'));
  const db = openDb(join(dir, 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

function freshDir() {
  return mkdtempSync(join(tmpdir(), 'robin-pre-checks-kb-'));
}

/** Fixed "now" for all tests: 2026-06-11T12:00:00Z */
const NOW = new Date('2026-06-11T12:00:00.000Z');
const now = () => NOW;

// ---------------------------------------------------------------------------
// F — predictions past deadline
// ---------------------------------------------------------------------------

test('F: skips when no prediction is past deadline; runs when one is due', () => {
  const db = freshDb();
  const knowledgeDir = freshDir();

  // No rows at all → skip
  assert.deepEqual(preCheck('F', { db, knowledgeDir, now }), {
    run: false,
    reason: 'no predictions past deadline',
  });

  // Future deadline → still skip
  db.prepare(`INSERT INTO predictions (claim, confidence, deadline) VALUES ('future', 0.7, ?)`).run(
    '2026-06-11T14:00:00.000Z',
  );
  assert.deepEqual(preCheck('F', { db, knowledgeDir, now }), {
    run: false,
    reason: 'no predictions past deadline',
  });

  // Past deadline, outcome IS NULL → run
  db.prepare(
    `INSERT INTO predictions (claim, confidence, deadline) VALUES ('overdue', 0.8, ?)`,
  ).run('2026-06-10T08:00:00.000Z');
  assert.deepEqual(preCheck('F', { db, knowledgeDir, now }), { run: true });

  closeDb(db);
});

test('F: predictions with NULL deadline never make F due', () => {
  const db = freshDb();
  const knowledgeDir = freshDir();

  db.prepare(
    `INSERT INTO predictions (claim, confidence, deadline) VALUES ('no deadline', 0.5, NULL)`,
  ).run();
  assert.deepEqual(preCheck('F', { db, knowledgeDir, now }), {
    run: false,
    reason: 'no predictions past deadline',
  });

  closeDb(db);
});

test('F: cross-format — sqlite-format deadline vs ISO now', () => {
  const db = freshDb();
  const knowledgeDir = freshDir();

  // Stored in sqlite format ('2026-06-10 12:00:00'), now is ISO — datetime() normalizes both
  db.prepare(
    `INSERT INTO predictions (claim, confidence, deadline) VALUES ('sqlite-fmt', 0.6, ?)`,
  ).run('2026-06-10 12:00:00');
  assert.deepEqual(preCheck('F', { db, knowledgeDir, now }), { run: true });

  closeDb(db);
});

// ---------------------------------------------------------------------------
// E — pending belief candidates
// ---------------------------------------------------------------------------

test('E: skips when no pending belief candidates; runs when one exists', () => {
  const db = freshDb();
  const knowledgeDir = freshDir();

  // No rows → skip
  assert.deepEqual(preCheck('E', { db, knowledgeDir, now }), {
    run: false,
    reason: 'no pending belief candidates',
  });

  // Non-pending row → still skip
  db.prepare(
    `INSERT INTO belief_candidates (topic, claim, status) VALUES ('t', 'c', 'resolved')`,
  ).run();
  assert.deepEqual(preCheck('E', { db, knowledgeDir, now }), {
    run: false,
    reason: 'no pending belief candidates',
  });

  // Pending row → run
  db.prepare(
    `INSERT INTO belief_candidates (topic, claim, status) VALUES ('t2', 'c2', 'pending')`,
  ).run();
  assert.deepEqual(preCheck('E', { db, knowledgeDir, now }), { run: true });

  closeDb(db);
});

// ---------------------------------------------------------------------------
// K — open alerts (resolved_at IS NULL)
// ---------------------------------------------------------------------------

test('K: skips when no open alerts; runs when one is open (resolved rows ignored)', () => {
  const db = freshDb();
  const knowledgeDir = freshDir();

  // No rows → skip
  assert.deepEqual(preCheck('K', { db, knowledgeDir, now }), {
    run: false,
    reason: 'no open alerts to remediate',
  });

  // Resolved alert → still skip
  db.prepare(
    `INSERT INTO alerts (severity, source, key, message, first_seen_at, last_seen_at, resolved_at)
     VALUES ('warning', 'test', 'k1', 'resolved msg', ?, ?, ?)`,
  ).run(NOW.toISOString(), NOW.toISOString(), NOW.toISOString());
  assert.deepEqual(preCheck('K', { db, knowledgeDir, now }), {
    run: false,
    reason: 'no open alerts to remediate',
  });

  // Open alert (resolved_at IS NULL) → run
  db.prepare(
    `INSERT INTO alerts (severity, source, key, message, first_seen_at, last_seen_at)
     VALUES ('critical', 'test', 'k2', 'open msg', ?, ?)`,
  ).run(NOW.toISOString(), NOW.toISOString());
  assert.deepEqual(preCheck('K', { db, knowledgeDir, now }), { run: true });

  closeDb(db);
});

// ---------------------------------------------------------------------------
// D — stale knowledge files (14-day threshold, recursive)
// ---------------------------------------------------------------------------

test('D: runs when a knowledge file is older than 14 days; skips when all files are fresh', () => {
  const db = freshDb();
  const knowledgeDir = freshDir();

  // Empty dir → skip (no files → none stale)
  assert.deepEqual(preCheck('D', { db, knowledgeDir, now }), {
    run: false,
    reason: 'no knowledge notes older than 14d',
  });

  // Fresh file (mtime = NOW − 5 days) → still skip
  const freshFile = join(knowledgeDir, 'fresh.md');
  writeFileSync(freshFile, 'fresh content');
  const freshTime = new Date(NOW.getTime() - 5 * 86_400_000);
  utimesSync(freshFile, freshTime, freshTime);
  assert.deepEqual(preCheck('D', { db, knowledgeDir, now }), {
    run: false,
    reason: 'no knowledge notes older than 14d',
  });

  // Stale file in a nested subdirectory (mtime = NOW − 20 days) → run
  const subDir = join(knowledgeDir, 'sub', 'nested');
  mkdirSync(subDir, { recursive: true });
  const staleFile = join(subDir, 'stale.md');
  writeFileSync(staleFile, 'stale content');
  const staleTime = new Date(NOW.getTime() - 20 * 86_400_000);
  utimesSync(staleFile, staleTime, staleTime);
  assert.deepEqual(preCheck('D', { db, knowledgeDir, now }), { run: true });

  closeDb(db);
});

// ---------------------------------------------------------------------------
// H — events in last 48h
// ---------------------------------------------------------------------------

test('H: runs when events exist in the last 48h; skips on a silent window', () => {
  const db = freshDb();
  const knowledgeDir = freshDir();

  // No events → skip
  assert.deepEqual(preCheck('H', { db, knowledgeDir, now }), {
    run: false,
    reason: 'no events in the last 48h',
  });

  // Event older than 48h → still skip
  const old = new Date(NOW.getTime() - 72 * 3_600_000);
  db.prepare(
    `INSERT INTO events (ts, kind, source, status, payload) VALUES (?, 'test.event', 'src', 'ok', '{}')`,
  ).run(old.toISOString());
  assert.deepEqual(preCheck('H', { db, knowledgeDir, now }), {
    run: false,
    reason: 'no events in the last 48h',
  });

  // Event within 48h (sqlite format) → run; cross-format: sqlite ts vs ISO boundary
  db.prepare(
    `INSERT INTO events (ts, kind, source, status, payload) VALUES (?, 'test.event', 'src', 'ok', '{}')`,
  ).run('2026-06-10 14:00:00'); // within 48h of NOW (2026-06-11T12:00:00Z)
  assert.deepEqual(preCheck('H', { db, knowledgeDir, now }), { run: true });

  closeDb(db);
});

// ---------------------------------------------------------------------------
// B, G, L always run
// ---------------------------------------------------------------------------

test('B, G, L always run', () => {
  const db = freshDb();
  const knowledgeDir = freshDir();

  for (const handler of ['B', 'G', 'L']) {
    assert.deepEqual(
      preCheck(handler, { db, knowledgeDir, now }),
      { run: true },
      `expected handler ${handler} to always run`,
    );
  }

  closeDb(db);
});

// ---------------------------------------------------------------------------
// Fail-open: a throwing check must not silence the handler
// ---------------------------------------------------------------------------

test('a throwing check fails OPEN (run:true) — a broken pre-check must not silence a handler', () => {
  const db = freshDb();

  // knowledgeDir pointing at a nonexistent path for D → readdirSync throws → { run: true }
  const missingDir = join(tmpdir(), 'robin-pre-checks-does-not-exist-xyz');
  assert.deepEqual(preCheck('D', { db, knowledgeDir: missingDir, now }), { run: true });

  closeDb(db);
});
