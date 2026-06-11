import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeDb, openDb } from '../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../brain/memory/migrations/index.ts';
import { verifyOutcome } from './verifiers.ts';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'robin-verifiers-'));
  const db = openDb(join(dir, 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

function freshDir() {
  return mkdtempSync(join(tmpdir(), 'robin-verifiers-kb-'));
}

/** Default deps where K is never the focus and knowledgeDir is a real empty dir. */
function baseDeps(db: ReturnType<typeof freshDb>, runStartIso: string) {
  return {
    db,
    runStartIso,
    knowledgeDir: freshDir(),
    worktreeHasChanges: () => false,
  };
}

const RUN_START = '2026-06-11T12:00:00.000Z';

// ---------------------------------------------------------------------------
// B — research.brief event since run start (cross-format: sqlite ts vs ISO start)
// ---------------------------------------------------------------------------

test('B passes when a research.brief event has sqlite-format ts after ISO runStart', () => {
  const db = freshDb();
  db.prepare(
    `INSERT INTO events (ts, kind, source, status, payload) VALUES (?, 'research.brief', 'agent', 'ok', '{}')`,
  ).run('2026-06-11 12:30:00'); // sqlite format, AFTER the ISO runStart
  assert.equal(verifyOutcome('B', baseDeps(db, RUN_START)), 'pass');
  closeDb(db);
});

test('B fails when the only research.brief event predates the run', () => {
  const db = freshDb();
  db.prepare(
    `INSERT INTO events (ts, kind, source, status, payload) VALUES (?, 'research.brief', 'agent', 'ok', '{}')`,
  ).run('2026-06-11 11:30:00'); // sqlite format, BEFORE the ISO runStart
  assert.equal(verifyOutcome('B', baseDeps(db, RUN_START)), 'fail');
  closeDb(db);
});

// ---------------------------------------------------------------------------
// D / G — files changed under knowledgeDir (recursive)
// ---------------------------------------------------------------------------

test('D passes when a nested file mtime is at/after runStart (recursive scan)', () => {
  const db = freshDb();
  const kb = freshDir();
  const nested = join(kb, 'a', 'b');
  mkdirSync(nested, { recursive: true });
  const f = join(nested, 'note.md');
  writeFileSync(f, 'hello');
  const after = new Date('2026-06-11T12:05:00.000Z');
  utimesSync(f, after, after);
  assert.equal(
    verifyOutcome('D', {
      db,
      runStartIso: RUN_START,
      knowledgeDir: kb,
      worktreeHasChanges: () => false,
    }),
    'pass',
  );
  closeDb(db);
});

test('D fails when no file under knowledgeDir changed since runStart', () => {
  const db = freshDb();
  const kb = freshDir();
  const f = join(kb, 'stale.md');
  writeFileSync(f, 'old');
  const before = new Date('2026-06-11T11:00:00.000Z');
  utimesSync(f, before, before);
  assert.equal(
    verifyOutcome('D', {
      db,
      runStartIso: RUN_START,
      knowledgeDir: kb,
      worktreeHasChanges: () => false,
    }),
    'fail',
  );
  closeDb(db);
});

test('G passes on a changed file just like D', () => {
  const db = freshDb();
  const kb = freshDir();
  const f = join(kb, 'gap.md');
  writeFileSync(f, 'filled');
  const after = new Date('2026-06-11T12:10:00.000Z');
  utimesSync(f, after, after);
  assert.equal(
    verifyOutcome('G', {
      db,
      runStartIso: RUN_START,
      knowledgeDir: kb,
      worktreeHasChanges: () => false,
    }),
    'pass',
  );
  closeDb(db);
});

// ---------------------------------------------------------------------------
// E — belief_candidates OR corrections (record_correction in E's allowlist)
// ---------------------------------------------------------------------------

test('E passes on a belief_candidates row created after runStart', () => {
  const db = freshDb();
  db.prepare(`INSERT INTO belief_candidates (topic, claim, created_at) VALUES ('t', 'c', ?)`).run(
    '2026-06-11 12:15:00',
  ); // sqlite format after ISO runStart
  assert.equal(verifyOutcome('E', baseDeps(db, RUN_START)), 'pass');
  closeDb(db);
});

test('E passes on a corrections row alone (record_correction allowlist deviation)', () => {
  const db = freshDb();
  db.prepare(`INSERT INTO corrections (ts, what, correction) VALUES (?, 'w', 'c')`).run(
    '2026-06-11 12:20:00',
  );
  assert.equal(verifyOutcome('E', baseDeps(db, RUN_START)), 'pass');
  closeDb(db);
});

test('E fails when neither candidates nor corrections appeared since runStart', () => {
  const db = freshDb();
  db.prepare(`INSERT INTO belief_candidates (topic, claim, created_at) VALUES ('t', 'c', ?)`).run(
    '2026-06-11 11:00:00',
  );
  db.prepare(`INSERT INTO corrections (ts, what, correction) VALUES (?, 'w', 'c')`).run(
    '2026-06-11 11:00:00',
  );
  assert.equal(verifyOutcome('E', baseDeps(db, RUN_START)), 'fail');
  closeDb(db);
});

// ---------------------------------------------------------------------------
// H — belief_candidates only; a corrections row does NOT satisfy H
// ---------------------------------------------------------------------------

test('H passes on a belief_candidates row after runStart', () => {
  const db = freshDb();
  db.prepare(`INSERT INTO belief_candidates (topic, claim, created_at) VALUES ('t', 'c', ?)`).run(
    '2026-06-11 12:25:00',
  );
  assert.equal(verifyOutcome('H', baseDeps(db, RUN_START)), 'pass');
  closeDb(db);
});

test('H fails when only a corrections row appeared (corrections do not satisfy H)', () => {
  const db = freshDb();
  db.prepare(`INSERT INTO corrections (ts, what, correction) VALUES (?, 'w', 'c')`).run(
    '2026-06-11 12:25:00',
  );
  assert.equal(verifyOutcome('H', baseDeps(db, RUN_START)), 'fail');
  closeDb(db);
});

// ---------------------------------------------------------------------------
// F — predictions.resolved_at (ISO format with T/Z) vs ISO runStart
// ---------------------------------------------------------------------------

test('F passes when predictions.resolved_at (ISO) is at/after runStart', () => {
  const db = freshDb();
  db.prepare(`INSERT INTO predictions (claim, confidence, resolved_at) VALUES ('c', 0.7, ?)`).run(
    '2026-06-11T12:45:00.000Z',
  ); // ISO format
  assert.equal(verifyOutcome('F', baseDeps(db, RUN_START)), 'pass');
  closeDb(db);
});

test('F fails when all prediction resolutions predate the run', () => {
  const db = freshDb();
  db.prepare(`INSERT INTO predictions (claim, confidence, resolved_at) VALUES ('c', 0.7, ?)`).run(
    '2026-06-11T11:45:00.000Z',
  );
  assert.equal(verifyOutcome('F', baseDeps(db, RUN_START)), 'fail');
  closeDb(db);
});

// ---------------------------------------------------------------------------
// K — worktree present + injected worktreeHasChanges
// ---------------------------------------------------------------------------

test('K passes when worktree set and worktreeHasChanges returns true', () => {
  const db = freshDb();
  assert.equal(
    verifyOutcome('K', {
      db,
      runStartIso: RUN_START,
      knowledgeDir: freshDir(),
      worktree: '/tmp/wt',
      worktreeHasChanges: () => true,
    }),
    'pass',
  );
  closeDb(db);
});

test('K fails when worktree is undefined', () => {
  const db = freshDb();
  assert.equal(
    verifyOutcome('K', {
      db,
      runStartIso: RUN_START,
      knowledgeDir: freshDir(),
      worktree: undefined,
      worktreeHasChanges: () => true,
    }),
    'fail',
  );
  closeDb(db);
});

test('K fails when worktreeHasChanges returns false', () => {
  const db = freshDb();
  assert.equal(
    verifyOutcome('K', {
      db,
      runStartIso: RUN_START,
      knowledgeDir: freshDir(),
      worktree: '/tmp/wt',
      worktreeHasChanges: () => false,
    }),
    'fail',
  );
  closeDb(db);
});

// ---------------------------------------------------------------------------
// L and unknown ids — unverifiable
// ---------------------------------------------------------------------------

test('L is unverifiable (read-only brief)', () => {
  const db = freshDb();
  assert.equal(verifyOutcome('L', baseDeps(db, RUN_START)), 'unverifiable');
  closeDb(db);
});

test('unknown handler ids are unverifiable', () => {
  const db = freshDb();
  assert.equal(verifyOutcome('Z', baseDeps(db, RUN_START)), 'unverifiable');
  closeDb(db);
});

// ---------------------------------------------------------------------------
// Exceptions degrade to unverifiable — never throw
// ---------------------------------------------------------------------------

test('D with a nonexistent knowledgeDir degrades to unverifiable (never throws)', () => {
  const db = freshDb();
  assert.equal(
    verifyOutcome('D', {
      db,
      runStartIso: RUN_START,
      knowledgeDir: join(tmpdir(), 'robin-verifiers-does-not-exist-xyz'),
      worktreeHasChanges: () => false,
    }),
    'unverifiable',
  );
  closeDb(db);
});
