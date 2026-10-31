import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDb, type RobinDb } from '../memory/db.ts';
import { allMigrations, applyMigrations } from '../memory/migrations/index.ts';
import {
  __resetPredictionGate,
  checkPredictionCreation,
  notePredictionInserted,
} from './prediction-gate.ts';

function makeDb(): RobinDb {
  const dir = mkdtempSync(join(tmpdir(), 'robin-prediction-gate-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

/** Seed a minimal event row for a source at a given timestamp. */
function ingestTestEvent(db: RobinDb, input: { source: string; ts: string }): void {
  db.prepare(
    `INSERT INTO events (ts, kind, source, status, payload) VALUES (?, 'integration.tick', ?, 'ok', '{}')`,
  ).run(input.ts, input.source);
}

test('fresh stream passes; dead stream rejects; stale stream rejects', () => {
  const db = makeDb();
  ingestTestEvent(db, { source: 'whoop', ts: '2026-08-09T00:00:00Z' });
  const now = new Date('2026-08-10T00:00:00Z');
  assert.equal(checkPredictionCreation(db, { sourceStream: 'whoop.recovery', now }).ok, true);
  assert.equal(checkPredictionCreation(db, { sourceStream: 'lrc.catalog', now }).ok, false); // no events
  const stale = checkPredictionCreation(db, {
    sourceStream: 'whoop.recovery',
    now: new Date('2026-09-10T00:00:00Z'),
  });
  assert.equal(stale.ok, false); // > 14d old
});

test('agent-run cap: 3rd insert rejected, non-agent unaffected', () => {
  __resetPredictionGate();
  const db = makeDb();
  assert.equal(checkPredictionCreation(db, { isAgentRun: true }).ok, true);
  notePredictionInserted();
  assert.equal(checkPredictionCreation(db, { isAgentRun: true }).ok, true);
  notePredictionInserted();
  assert.equal(checkPredictionCreation(db, { isAgentRun: true }).ok, false);
  assert.equal(checkPredictionCreation(db, { isAgentRun: false }).ok, true);
});
