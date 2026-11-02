import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { enqueueJob, type JobRow } from '../../kernel/scheduler/claim.ts';
import { createLogger } from '../../lib/logging/logger.ts';
import { closeDb, openDb, type RobinDb } from '../memory/db.ts';
import { allMigrations, applyMigrations } from '../memory/migrations/index.ts';
import {
  COGNITION_CHILD_JOBS,
  parseChildArgs,
  renewalBeat,
  renewChildLease,
  runCognitionChild,
  shouldReleaseLockOnFinish,
  takeOverLease,
  writeChildCompletion,
} from './cognition-runner-entry.ts';

const silentLog = () => createLogger({ module: 'test', level: 'silent' });

// Same in-memory-DB fixture pattern as sibling cognition tests (jobs.test.ts,
// biographer.test.ts) and the scheduler's own claim.test.ts.
function testDb(): RobinDb {
  const dir = mkdtempSync(join(tmpdir(), 'robin-cog-child-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

/** Insert a job row already leased by `workerId` (mirrors what the daemon's
 *  scheduler leaves behind right before spawning a detached child). */
function enqueueLeasedJob(db: RobinDb, name: string, workerId: string): number {
  const id = enqueueJob(db, {
    name,
    trigger_kind: 'cron',
    scheduled_at: new Date().toISOString(),
  });
  db.prepare(`UPDATE jobs SET state='leased', claimed_by=?, leased_until=? WHERE id=?`).run(
    workerId,
    new Date(Date.now() + 5 * 60_000).toISOString(),
    id,
  );
  return id;
}

function getJob(db: RobinDb, id: number): JobRow {
  return db.prepare('SELECT * FROM jobs WHERE id=?').get(id) as JobRow;
}

test('parseChildArgs extracts job and jobId, rejects garbage', () => {
  assert.deepStrictEqual(parseChildArgs(['--job=dream.run', '--job-id=42']), {
    job: 'dream.run',
    jobId: 42,
  });
  assert.strictEqual(parseChildArgs(['--job=dream.run']), null); // missing id
  assert.strictEqual(parseChildArgs(['--job-id=x', '--job=dream.run']), null); // NaN
  assert.strictEqual(parseChildArgs(['--job=rm-rf.run', '--job-id=1']), null); // unknown job
});

test('takeOverLease stamps child:<pid> only on a leased row with matching name', () => {
  const db = testDb();
  const id = enqueueLeasedJob(db, 'biographer.run', 'daemon-w1');
  assert.strictEqual(takeOverLease(db, id, 'biographer.run', 4242), true);
  const row = getJob(db, id);
  assert.strictEqual(row.claimed_by, 'child:4242');
  assert.ok(row.leased_until && row.leased_until > new Date().toISOString());
  // wrong name → refuse (defends against a stale/reused job id)
  const id2 = enqueueLeasedJob(db, 'dream.run', 'daemon-w1');
  assert.strictEqual(takeOverLease(db, id2, 'biographer.run', 4242), false);
  // non-leased row → refuse (row was reaped and reclaimed already)
  const id3 = enqueueLeasedJob(db, 'biographer.run', 'daemon-w1');
  db.prepare(`UPDATE jobs SET state='pending' WHERE id=?`).run(id3);
  assert.strictEqual(takeOverLease(db, id3, 'biographer.run', 4242), false);
  closeDb(db);
});

test('renewChildLease extends only own lease; writeChildCompletion guards on ownership', () => {
  const db = testDb();
  const id = enqueueLeasedJob(db, 'dream.run', 'daemon-w1');
  takeOverLease(db, id, 'dream.run', 7);
  assert.strictEqual(renewChildLease(db, id, 7), true);
  assert.strictEqual(renewChildLease(db, id, 999), false); // not our lease
  // completion writes state + re-arms cron only when we still own the row
  db.prepare(`UPDATE jobs SET trigger_kind='cron', payload=? WHERE id=?`).run(
    JSON.stringify({ cron: '50 3 * * *' }),
    id,
  );
  assert.strictEqual(writeChildCompletion(db, id, 7, 'ok'), true);
  assert.strictEqual(getJob(db, id).state, 'completed');
  const rearmed = db
    .prepare(`SELECT COUNT(*) n FROM jobs WHERE name='dream.run' AND state='pending'`)
    .get() as { n: number };
  assert.strictEqual(rearmed.n, 1); // cron re-armed by the child path
  // a zombie (lost ownership) must not stomp the row
  const id2 = enqueueLeasedJob(db, 'dream.run', 'daemon-w1');
  takeOverLease(db, id2, 'dream.run', 7);
  db.prepare(`UPDATE jobs SET claimed_by='child:8' WHERE id=?`).run(id2); // someone else took it
  assert.strictEqual(writeChildCompletion(db, id2, 7, 'error', 'deadline'), false);
  closeDb(db);
});

test('COGNITION_CHILD_JOBS carries per-job deadlines', () => {
  assert.strictEqual(COGNITION_CHILD_JOBS['biographer.run']?.deadlineMs, 15 * 60_000);
  assert.strictEqual(COGNITION_CHILD_JOBS['dream.run']?.deadlineMs, 45 * 60_000);
});

// Finding 1 (TOCTOU guard): writeChildCompletion's ownership check and its
// terminal-state write must be ONE atomic UPDATE (`WHERE id=? AND
// claimed_by=?`), not a SELECT-then-UPDATE — a cross-process reap+reclaim
// (recoverExpiredLeases re-pending the row, realistic on wake-from-sleep, plus
// someone else re-claiming it) landing in the gap between two separate
// statements must never let a stale UPDATE stomp the new claimant's row.
test('writeChildCompletion refuses — and leaves the row fully untouched — after an external reap+reclaim', () => {
  const db = testDb();
  const id = enqueueLeasedJob(db, 'dream.run', 'daemon-w1');
  takeOverLease(db, id, 'dream.run', 55);
  db.prepare(`UPDATE jobs SET trigger_kind='cron', payload=? WHERE id=?`).run(
    JSON.stringify({ cron: '50 3 * * *' }),
    id,
  );
  // Simulate recoverExpiredLeases re-pending the row, then a fresh worker
  // claiming it, both happening out from under the (still-running) child.
  db.prepare(`UPDATE jobs SET state='pending', claimed_by=NULL, leased_until=NULL WHERE id=?`).run(
    id,
  );
  db.prepare(
    `UPDATE jobs SET state='leased', claimed_by='daemon-w2', leased_until=? WHERE id=?`,
  ).run(new Date(Date.now() + 5 * 60_000).toISOString(), id);
  const before = getJob(db, id);

  assert.strictEqual(writeChildCompletion(db, id, 55, 'ok'), false);

  const after = getJob(db, id);
  assert.deepStrictEqual(after, before); // row completely untouched — no partial write
  assert.strictEqual(after.state, 'leased'); // still owned by the new claimant
  assert.strictEqual(after.claimed_by, 'daemon-w2');
  const rearmed = db
    .prepare(`SELECT COUNT(*) n FROM jobs WHERE name='dream.run' AND state='pending'`)
    .get() as { n: number };
  assert.strictEqual(rearmed.n, 0); // no cron re-arm — the zombie write never landed
  closeDb(db);
});

// Finding 2 (lock retained on lost ownership): the decision `finish()` (inside
// runCognitionChild) makes about releasing the single-flight lock, extracted
// as a pure function so it's testable without spawning a real child (Task 6)
// or a deps-injection seam runCognitionChild doesn't have yet. release() is
// pid-blind, so releasing after a failed write could delete a NEW run's lock.
test('shouldReleaseLockOnFinish: release only when the completion write landed', () => {
  assert.strictEqual(shouldReleaseLockOnFinish(true), true);
  assert.strictEqual(shouldReleaseLockOnFinish(false), false);
});

// Review backlog item 4: a renewal beat that THROWS (SQLITE_BUSY under WAL
// contention, say) must SKIP that beat, not exit — only an explicit
// ownership-loss (renew returns false) may signal exit. Driving renewalBeat
// directly (rather than through the setInterval callback it's extracted from)
// makes this testable without fake timers.
test('renewalBeat: a throwing renew is swallowed — beat continues (returns true), no exit signaled', () => {
  const db = testDb();
  let calls = 0;
  const throwingRenew = () => {
    calls++;
    throw new Error('SQLITE_BUSY');
  };
  assert.strictEqual(renewalBeat(db, 1, 999, silentLog(), throwingRenew), true);
  assert.strictEqual(calls, 1);
  closeDb(db);
});

test('renewalBeat: an explicit ownership loss (renew returns false) signals exit (returns false)', () => {
  const db = testDb();
  assert.strictEqual(
    renewalBeat(db, 1, 999, silentLog(), () => false),
    false,
  );
  closeDb(db);
});

test('renewalBeat: a successful renew signals continue (returns true)', () => {
  const db = testDb();
  assert.strictEqual(
    renewalBeat(db, 1, 999, silentLog(), () => true),
    true,
  );
  closeDb(db);
});

test('renewalBeat: next beat proceeds normally after a prior beat threw (no persistent poisoning)', () => {
  const db = testDb();
  let attempt = 0;
  const flakyRenew = () => {
    attempt++;
    if (attempt === 1) throw new Error('SQLITE_BUSY');
    return true; // second beat: the transient error is gone, renewal succeeds
  };
  assert.strictEqual(renewalBeat(db, 1, 999, silentLog(), flakyRenew), true); // beat 1: threw, swallowed
  assert.strictEqual(renewalBeat(db, 1, 999, silentLog(), flakyRenew), true); // beat 2: succeeds
  assert.strictEqual(attempt, 2);
  closeDb(db);
});

test('renewalBeat: default renew fn is the real renewChildLease against a real row', () => {
  const db = testDb();
  const id = enqueueLeasedJob(db, 'dream.run', 'daemon-w1');
  takeOverLease(db, id, 'dream.run', 321);
  assert.strictEqual(renewalBeat(db, id, 321, silentLog()), true);
  assert.strictEqual(renewalBeat(db, id, 999, silentLog()), false); // not our lease → ownership loss
  closeDb(db);
});

// Child lifecycle log lines: an empty cognition-children.log must mean broken,
// never healthy-quiet. Drives the real runCognitionChild core path end to end
// (own db connection, own logger, real takeover/finish) against a temp
// ROBIN_USER_DATA_DIR, with the job's `run` swapped for a fast no-op — this
// test is about the harness's own lifecycle logging around takeover/finish,
// not about biographer's internal behavior against an empty DB.
test('runCognitionChild logs both child lifecycle lines (run started / run finished) around a completed run', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'robin-cog-child-lifecycle-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const setupDb = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(setupDb, allMigrations);
  const jobId = enqueueLeasedJob(setupDb, 'biographer.run', 'daemon-w1');
  closeDb(setupDb);

  const prevUserData = process.env.ROBIN_USER_DATA_DIR;
  process.env.ROBIN_USER_DATA_DIR = dir;

  const spec = COGNITION_CHILD_JOBS['biographer.run']!;
  const originalRun = spec.run;
  spec.run = async () => {};

  try {
    const code = await runCognitionChild({ job: 'biographer.run', jobId });
    assert.equal(code, 0);
  } finally {
    spec.run = originalRun;
    if (prevUserData === undefined) delete process.env.ROBIN_USER_DATA_DIR;
    else process.env.ROBIN_USER_DATA_DIR = prevUserData;
  }

  const logPath = join(dir, 'observability', 'logs', 'cognition-children.log');
  const lines = readFileSync(logPath, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));

  const started = lines.find((l) => l.msg === 'child: run started');
  assert.ok(started, 'expected a "child: run started" log line');
  assert.equal(started.job, 'biographer.run');
  assert.equal(started.jobId, jobId);

  const finished = lines.find((l) => l.msg === 'child: run finished');
  assert.ok(finished, 'expected a "child: run finished" log line');
  assert.equal(finished.job, 'biographer.run');
  assert.equal(finished.jobId, jobId);
  assert.equal(finished.outcome, 'ok');
});
