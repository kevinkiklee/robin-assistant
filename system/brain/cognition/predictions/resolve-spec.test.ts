import assert from 'node:assert/strict';
import { test } from 'node:test';
import { closeDb, type RobinDb } from '../../memory/db.ts';
import { runDream } from '../dream.ts';
import { resolveSpecPredictions } from './resolve-spec.ts';
import { addRecovery, freshDb } from './test-helpers.ts';

interface Row {
  outcome: string | null;
  brier_delta: number | null;
  resolution_source: string | null;
  evidence: string | null;
}

function predict(
  db: RobinDb,
  claim: string,
  confidence: number,
  deadline: string | null,
  spec: Record<string, unknown> | string | null,
): number {
  const info = db
    .prepare(`INSERT INTO predictions (claim, confidence, deadline, spec) VALUES (?, ?, ?, ?)`)
    .run(
      claim,
      confidence,
      deadline,
      spec === null ? null : typeof spec === 'string' ? spec : JSON.stringify(spec),
    );
  return Number(info.lastInsertRowid);
}

const row = (db: RobinDb, id: number) =>
  db
    .prepare(
      `SELECT outcome, brier_delta, resolution_source, evidence FROM predictions WHERE id = ?`,
    )
    .get(id) as Row;

const recSpec = (op: string, threshold: number) => ({
  source: 'whoop',
  metric: 'recovery_score',
  op,
  threshold,
  at: '2027-04-14',
});

test('resolver: right/wrong from data, Brier stamped, source auto:<source>', () => {
  const db = freshDb();
  addRecovery(db, '2027-04-14', 58);
  const right = predict(db, 'recovery < 72', 0.8, '2027-04-14', recSpec('<', 72));
  const wrong = predict(db, 'recovery >= 72', 0.7, '2027-04-14', recSpec('>=', 72));
  const r = resolveSpecPredictions(db, new Date('2027-04-15T08:00:00Z'));
  assert.equal(r.right, 1);
  assert.equal(r.wrong, 1);
  const a = row(db, right);
  assert.equal(a.outcome, 'right');
  assert.ok(Math.abs((a.brier_delta ?? -1) - 0.04) < 1e-9);
  assert.equal(a.resolution_source, 'auto:whoop');
  assert.match(a.evidence ?? '', /reading 58/);
  const b = row(db, wrong);
  assert.equal(b.outcome, 'wrong');
  assert.ok(Math.abs((b.brier_delta ?? -1) - 0.49) < 1e-9);
  closeDb(db);
});

test('resolver: not due before `at` ends; no data → stays open, then expires after grace', () => {
  const db = freshDb();
  const id = predict(db, 'recovery >= 72', 0.5, '2027-04-14', recSpec('>=', 72));
  let r = resolveSpecPredictions(db, new Date('2027-04-14T20:00:00Z'));
  assert.equal(r.notDue, 1);
  r = resolveSpecPredictions(db, new Date('2027-04-16T08:00:00Z'));
  assert.equal(r.noData, 1);
  assert.equal(row(db, id).outcome, null, 'no reading → left open for a later re-sync');
  // late-arriving data inside the grace window still resolves it
  addRecovery(db, '2027-04-14', 79);
  r = resolveSpecPredictions(db, new Date('2027-04-17T08:00:00Z'));
  assert.equal(r.right, 1);

  const stuck = predict(db, 'recovery >= 72 (dead band)', 0.5, '2027-03-10', {
    ...recSpec('>=', 72),
    at: '2027-03-10',
  });
  r = resolveSpecPredictions(db, new Date('2027-04-17T08:00:00Z'));
  assert.equal(r.expired, 1);
  const s = row(db, stuck);
  assert.equal(s.outcome, 'unverifiable');
  assert.equal(s.resolution_source, 'auto:whoop:no-data');
  assert.equal(s.brier_delta, null);
  closeDb(db);
});

test('resolver: `at` falls back to the deadline; corrupt stored spec expires after grace', () => {
  const db = freshDb();
  addRecovery(db, '2027-04-14', 77);
  const { at: _at, ...noAt } = recSpec('>=', 72);
  const id = predict(db, 'recovery >= 72', 0.6, '2027-04-14', noAt);
  const bad = predict(db, 'corrupt', 0.6, '2027-03-10', '{not json');
  const r = resolveSpecPredictions(db, new Date('2027-04-15T08:00:00Z'));
  assert.equal(row(db, id).outcome, 'right');
  assert.equal(r.expired, 1);
  assert.equal(row(db, bad).resolution_source, 'auto:invalid-spec');
  closeDb(db);
});

test('resolver: never touches already-resolved rows', () => {
  const db = freshDb();
  addRecovery(db, '2027-04-14', 12);
  const id = predict(db, 'hand-resolved', 0.9, '2027-04-14', recSpec('>=', 72));
  db.prepare(`UPDATE predictions SET outcome = 'right' WHERE id = ?`).run(id);
  const r = resolveSpecPredictions(db, new Date('2027-04-15T08:00:00Z'));
  assert.equal(r.considered, 0);
  assert.equal(row(db, id).outcome, 'right');
  closeDb(db);
});

test('dream: spec resolver runs BEFORE the sweep; sweep only takes spec-less rows', async () => {
  const db = freshDb();
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  addRecovery(db, yesterday, 74);
  const specd = predict(db, 'recovery >= 72', 0.7, yesterday, {
    ...recSpec('>=', 72),
    at: yesterday,
  });
  const pending = predict(db, 'recovery >= 72 tomorrow-ish', 0.7, yesterday, {
    ...recSpec('>=', 72),
    at: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10),
  });
  const bare = predict(db, 'it will rain', 0.7, yesterday, null);

  const r = await runDream(db, null);
  assert.equal(r.predictionsResolved, 2);
  const s = row(db, specd);
  assert.equal(s.outcome, 'right', 'resolved from data, not swept as unverifiable');
  assert.equal(s.resolution_source, 'auto:whoop');
  assert.equal(
    row(db, pending).outcome,
    null,
    "spec'd but not due → never swept, even past deadline",
  );
  const b = row(db, bare);
  assert.equal(b.outcome, 'unverifiable');
  assert.equal(b.resolution_source, 'dream:no-spec');
  closeDb(db);
});
