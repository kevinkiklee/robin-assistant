import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeDb, openDb } from '../memory/db.ts';
import { allMigrations, applyMigrations } from '../memory/migrations/index.ts';
import { COGNITION_JOBS, registerCognitionJobs } from './jobs.ts';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'robin-cog-jobs-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

test('cognition jobs: COGNITION_JOBS lists biographer + dream + automatic doc ingest', () => {
  const names = COGNITION_JOBS.map((j) => j.name);
  assert.ok(names.includes('biographer.run'));
  assert.ok(names.includes('dream.run'));
  // ingest-docs runs on a cron so the user never has to invoke it by hand.
  assert.ok(names.includes('ingest-docs.run'));
});

test('cognition jobs: registerCognitionJobs seeds cron rows for each', () => {
  const db = freshDb();
  const fakeDaemon = { registerHandler: () => {} } as unknown as Parameters<
    typeof registerCognitionJobs
  >[0];
  registerCognitionJobs(fakeDaemon, db, () => null);
  const rows = db.prepare("SELECT name FROM jobs WHERE state='pending'").all() as Array<{
    name: string;
  }>;
  const names = rows.map((r) => r.name);
  assert.ok(names.includes('biographer.run'));
  assert.ok(names.includes('dream.run'));
  closeDb(db);
});

test('cognition jobs: getDomainGating resolver is accepted as 5th parameter', () => {
  // registerCognitionJobs must accept a getDomainGating resolver as its 5th parameter,
  // mirroring how getDraftClaims is the 4th. The resolver is lazy — only called inside
  // the biographer.run handler, not at registration time.
  const db = freshDb();
  const fakeDaemon = { registerHandler: () => {} } as unknown as Parameters<
    typeof registerCognitionJobs
  >[0];

  let resolverCallCount = 0;
  const getDomainGating = () => {
    resolverCallCount++;
    return false;
  };

  // Must not throw — 5 args is the new valid signature.
  registerCognitionJobs(
    fakeDaemon,
    db,
    () => null,
    () => true,
    getDomainGating,
  );

  // Resolver is lazy: not called during registration, only inside the handler.
  assert.equal(resolverCallCount, 0, 'resolver is lazy — not called during registration');

  closeDb(db);
});

test('cognition jobs: getDomainGating defaults to () => true when omitted', () => {
  const db = freshDb();
  // registerCognitionJobs must be callable with only 3 positional args and still
  // work — the default () => true kicks in for both getDraftClaims and getDomainGating.
  const fakeDaemon = { registerHandler: () => {} } as unknown as Parameters<
    typeof registerCognitionJobs
  >[0];
  // Should not throw even without the 4th/5th args.
  assert.doesNotThrow(() => registerCognitionJobs(fakeDaemon, db, () => null));
  closeDb(db);
});
