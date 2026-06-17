import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeDb, openDb, type RobinDb } from '../../memory/db.ts';
import { allMigrations, applyMigrations } from '../../memory/migrations/index.ts';
import {
  habitHintLine,
  SENSITIVE_DOMAINS,
  selectBriefHabitLine,
  selectHabitInjections,
} from './habit-recall.ts';
import { insertHabit } from './habits-store.ts';

function freshDb(): RobinDb {
  const dir = mkdtempSync(join(tmpdir(), 'robin-habit-recall-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

// A unit query vector. Habit embeddings below are crafted to land at controlled cosine
// similarities against it: [1,0] = cos 1.0, [0,1] = cos 0, and a mixed vector for the
// in-between band that separates the normal floor (0.60) from the sensitive floor (0.78).
const Q = [1, 0];

// cos([1,0], [cosθ, sinθ]) = cosθ. θ chosen so cos ≈ 0.7 — ABOVE the normal floor (0.60)
// but BELOW the sensitive floor (0.78): the exact band that proves the sensitive gate.
const MID = [0.7, Math.sqrt(1 - 0.7 * 0.7)]; // cosine to Q ≈ 0.70

test('selectHabitInjections: ranks by cosine and caps at 2', () => {
  const db = freshDb();
  // Three relevant (cosine 1.0 / 0.98 / 0.95) + one irrelevant (cosine 0).
  insertHabit(db, {
    statement: 'best match',
    domain: 'creative',
    patternKind: 'temporal',
    embedding: [1, 0],
  });
  insertHabit(db, {
    statement: 'second match',
    domain: 'creative',
    patternKind: 'temporal',
    embedding: [0.98, 0.2],
  });
  insertHabit(db, {
    statement: 'third match',
    domain: 'creative',
    patternKind: 'temporal',
    embedding: [0.95, 0.31],
  });
  insertHabit(db, {
    statement: 'orthogonal',
    domain: 'creative',
    patternKind: 'temporal',
    embedding: [0, 1],
  });

  const hits = selectHabitInjections(db, Q);
  assert.equal(hits.length, 2, 'capped at 2');
  assert.equal(hits[0].statement, 'best match', 'highest cosine first');
  assert.equal(hits[1].statement, 'second match');
  assert.ok(hits.every((h) => h.line.startsWith('inferred tendency (hint, not fact):')));
  assert.ok(!hits.some((h) => h.statement === 'orthogonal'), 'sub-floor habit excluded');
  closeDb(db);
});

test('selectHabitInjections: cap option limits the slice', () => {
  const db = freshDb();
  insertHabit(db, {
    statement: 'a',
    domain: 'creative',
    patternKind: 'temporal',
    embedding: [1, 0],
  });
  insertHabit(db, {
    statement: 'b',
    domain: 'creative',
    patternKind: 'temporal',
    embedding: [0.99, 0.1],
  });
  assert.equal(selectHabitInjections(db, Q, { cap: 1 }).length, 1);
  assert.equal(selectHabitInjections(db, Q, { cap: 0 }).length, 0);
  closeDb(db);
});

test('selectHabitInjections: empty store / no embeddings → nothing', () => {
  const db = freshDb();
  assert.deepEqual(selectHabitInjections(db, Q), []);
  // A habit with no embedding is not a candidate.
  insertHabit(db, { statement: 'no embed', domain: 'creative', patternKind: 'temporal' });
  assert.deepEqual(selectHabitInjections(db, Q), []);
  closeDb(db);
});

test('selectHabitInjections: empty query embedding → nothing', () => {
  const db = freshDb();
  insertHabit(db, {
    statement: 'x',
    domain: 'creative',
    patternKind: 'temporal',
    embedding: [1, 0],
  });
  assert.deepEqual(selectHabitInjections(db, []), []);
  closeDb(db);
});

test('selectHabitInjections: retired habits are never candidates', () => {
  const db = freshDb();
  insertHabit(db, {
    statement: 'retired pattern',
    domain: 'creative',
    patternKind: 'temporal',
    embedding: [1, 0],
    status: 'retired',
  });
  assert.deepEqual(selectHabitInjections(db, Q), [], 'retired excluded');
  closeDb(db);
});

test('selectHabitInjections: a sensitive-domain habit needs a STRICTER match', () => {
  const db = freshDb();
  // Same MID embedding (cosine ≈ 0.70 to Q) for a creative vs a health habit.
  insertHabit(db, {
    statement: 'creative tendency',
    domain: 'creative',
    patternKind: 'temporal',
    embedding: MID,
  });
  insertHabit(db, {
    statement: 'health tendency',
    domain: 'health',
    patternKind: 'temporal',
    embedding: MID,
  });

  // At cosine ≈ 0.70: ABOVE the normal floor → creative injects; BELOW the sensitive floor
  // → health does NOT.
  const normal = selectHabitInjections(db, Q);
  const domains = normal.map((h) => h.domain);
  assert.ok(domains.includes('creative'), 'creative habit injected at a normal relevance level');
  assert.ok(
    !domains.includes('health'),
    'health (sensitive) NOT injected at a normal relevance level',
  );

  // Drop the sensitive floor below 0.70 → the same health habit now qualifies. Proves the
  // gate is a threshold, not a blanket block.
  const relaxed = selectHabitInjections(db, Q, { sensitiveMinSimilarity: 0.5 });
  assert.ok(
    relaxed.some((h) => h.domain === 'health'),
    'health injects once its (strict) relevance bar is met',
  );
  closeDb(db);
});

test('SENSITIVE_DOMAINS covers health, finance, relationships', () => {
  assert.ok(SENSITIVE_DOMAINS.has('health'));
  assert.ok(SENSITIVE_DOMAINS.has('finance'));
  assert.ok(SENSITIVE_DOMAINS.has('relationships'));
  assert.ok(!SENSITIVE_DOMAINS.has('creative'));
});

test('habitHintLine prefixes a clearly non-factual label', () => {
  assert.equal(
    habitHintLine('  shoots most at golden hour  '),
    'inferred tendency (hint, not fact): shoots most at golden hour',
  );
});

// ── Brief line (design §10) ──────────────────────────────────────────────────

test('selectBriefHabitLine: picks the highest-confidence graduated habit', () => {
  const db = freshDb();
  insertHabit(db, {
    statement: 'prefers prime lenses',
    domain: 'preferences',
    patternKind: 'preference',
    status: 'graduated',
    confidence: 0.6,
  });
  insertHabit(db, {
    statement: 'edits in the evening',
    domain: 'creative',
    patternKind: 'temporal',
    status: 'graduated',
    confidence: 0.9,
  });
  // A soft habit must NOT surface in the brief (graduated only).
  insertHabit(db, {
    statement: 'soft tendency',
    domain: 'creative',
    patternKind: 'temporal',
    status: 'soft',
    confidence: 0.99,
  });

  assert.equal(selectBriefHabitLine(db), 'Behavioral note: edits in the evening');
  closeDb(db);
});

test('selectBriefHabitLine: excludes sensitive domains from the unprompted surface', () => {
  const db = freshDb();
  insertHabit(db, {
    statement: 'spends more before trips',
    domain: 'finance',
    patternKind: 'purchase',
    status: 'graduated',
    confidence: 0.95,
  });
  insertHabit(db, {
    statement: 'recovers slowly after late nights',
    domain: 'health',
    patternKind: 'temporal',
    status: 'graduated',
    confidence: 0.95,
  });
  assert.equal(selectBriefHabitLine(db), null, 'no sensitive-domain habit surfaces');
  closeDb(db);
});

test('selectBriefHabitLine: null when there is no graduated habit', () => {
  const db = freshDb();
  insertHabit(db, {
    statement: 'soft only',
    domain: 'creative',
    patternKind: 'temporal',
    status: 'soft',
    confidence: 0.9,
  });
  assert.equal(selectBriefHabitLine(db), null);
  closeDb(db);
});
