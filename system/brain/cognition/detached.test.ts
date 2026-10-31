import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { recordAlert } from '../../kernel/runtime/alert-store.ts';
import { enqueueJob, type JobRow } from '../../kernel/scheduler/claim.ts';
import { closeDb, openDb, type RobinDb } from '../memory/db.ts';
import { allMigrations, applyMigrations } from '../memory/migrations/index.ts';
import { spawnCognitionChild } from './detached.ts';

// Same in-memory-DB fixture pattern as cognition-runner-entry.test.ts.
function testDb(): RobinDb {
  const dir = mkdtempSync(join(tmpdir(), 'robin-cog-detached-'));
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

function fakeChild() {
  const ch = new EventEmitter() as EventEmitter & { unref: () => void; pid: number };
  ch.unref = () => {};
  ch.pid = 5555;
  return ch;
}

test('spawns detached child with job argv and returns detached', () => {
  const db = testDb();
  const id = enqueueLeasedJob(db, 'dream.run', 'w1');
  const calls: unknown[][] = [];
  const ch = fakeChild();
  const r = spawnCognitionChild(db, getJob(db, id), {
    spawn: ((cmd: string, argv: string[], opts: object) => {
      calls.push([cmd, argv, opts]);
      return ch;
    }) as never,
    userDataDir: mkdtempSync(join(tmpdir(), 'cog-')),
    entryPath: () => '/x/cognition-runner-entry.ts',
  });
  assert.strictEqual(r, 'detached');
  const argv = calls[0]?.[1] as string[];
  assert.ok(argv.join(' ').includes('--job=dream.run'));
  assert.ok(argv.join(' ').includes(`--job-id=${id}`));
  const opts = calls[0]?.[2] as { detached?: boolean };
  assert.strictEqual(opts.detached, true);
  closeDb(db);
});

test('compiled .js entry spawns via node (process.execPath), not pnpm/tsx', () => {
  const db = testDb();
  const id = enqueueLeasedJob(db, 'dream.run', 'w1');
  const calls: unknown[][] = [];
  const ch = fakeChild();
  const r = spawnCognitionChild(db, getJob(db, id), {
    spawn: ((cmd: string, argv: string[], opts: object) => {
      calls.push([cmd, argv, opts]);
      return ch;
    }) as never,
    userDataDir: mkdtempSync(join(tmpdir(), 'cog-')),
    entryPath: () => '/x/cognition-runner-entry.js',
  });
  assert.strictEqual(r, 'detached');
  const [cmd, argv] = calls[0] as [string, string[]];
  assert.strictEqual(cmd, process.execPath);
  assert.strictEqual(argv[0], '/x/cognition-runner-entry.js');
  assert.ok(argv.join(' ').includes('--job=dream.run'));
  closeDb(db);
});

test('fresh lock → skipped, no spawn', () => {
  const db = testDb();
  const dir = mkdtempSync(join(tmpdir(), 'cog-'));
  const id1 = enqueueLeasedJob(db, 'dream.run', 'w1');
  let spawns = 0;
  const deps = {
    spawn: (() => {
      spawns++;
      return fakeChild();
    }) as never,
    userDataDir: dir,
    entryPath: () => '/x/e.ts',
  };
  assert.strictEqual(spawnCognitionChild(db, getJob(db, id1), deps), 'detached');
  const id2 = enqueueLeasedJob(db, 'dream.run', 'w1');
  assert.strictEqual(spawnCognitionChild(db, getJob(db, id2), deps), 'skipped');
  assert.strictEqual(spawns, 1);
  closeDb(db);
});

test('nonzero exit within 15s on a still-leased row → errored + alert + lock released', () => {
  const db = testDb();
  const dir = mkdtempSync(join(tmpdir(), 'cog-'));
  const id = enqueueLeasedJob(db, 'biographer.run', 'w1');
  const ch = fakeChild();
  spawnCognitionChild(db, getJob(db, id), {
    spawn: (() => ch) as never,
    userDataDir: dir,
    entryPath: () => '/x/e.ts',
  });
  ch.emit('exit', 1); // immediate death — the pnpm-binding case
  const row = getJob(db, id);
  assert.strictEqual(row.state, 'errored');
  assert.match(row.last_error ?? '', /child died at spawn/);
  const alert = db
    .prepare(`SELECT key FROM alerts WHERE source='cognition' AND resolved_at IS NULL`)
    .get() as { key: string } | undefined;
  assert.strictEqual(alert?.key, 'spawn-fail:biographer.run');
  // lock released → a fresh spawn succeeds again
  const id2 = enqueueLeasedJob(db, 'biographer.run', 'w1');
  assert.strictEqual(
    spawnCognitionChild(db, getJob(db, id2), {
      spawn: (() => fakeChild()) as never,
      userDataDir: dir,
      entryPath: () => '/x/e.ts',
    }),
    'detached',
  );
  closeDb(db);
});

// Regression (Finding 1, reviewer-verified Critical): the fast-fail path used
// to call completeJob without rescheduleCronAfterCompletion, so ONE spawn
// failure left zero pending rows for the job — permanently silencing
// biographer.run/dream.run until the next daemon restart, since nothing else
// ever re-arms a cron-triggered row that this watch (not the scheduler)
// completed.
test('fast-fail exit re-arms the cron — a pending row exists afterward', () => {
  const db = testDb();
  const dir = mkdtempSync(join(tmpdir(), 'cog-'));
  const id = enqueueLeasedJob(db, 'biographer.run', 'w1');
  db.prepare(`UPDATE jobs SET payload=? WHERE id=?`).run(JSON.stringify({ cron: '* * * * *' }), id);
  const ch = fakeChild();
  spawnCognitionChild(db, getJob(db, id), {
    spawn: (() => ch) as never,
    userDataDir: dir,
    entryPath: () => '/x/e.ts',
  });
  ch.emit('exit', 1);
  assert.strictEqual(getJob(db, id).state, 'errored');
  const pending = db
    .prepare(`SELECT COUNT(*) n FROM jobs WHERE name='biographer.run' AND state='pending'`)
    .get() as { n: number };
  assert.strictEqual(pending.n, 1, 'cron must be re-armed after a fast-fail completion');
  closeDb(db);
});

// Regression (Finding 2, reviewer-verified Critical, reproduced on this repo's
// Node): an async spawn failure (e.g. ENOENT — 'pnpm' unresolvable under
// launchd's trimmed PATH) fires ONLY 'error', never 'exit'. An EventEmitter
// 'error' with no listener throws synchronously, which would crash the whole
// daemon on the very first bad-PATH spawn.
test('async spawn error is contained: no throw, row errored, alert recorded, cron re-armed, lock released', () => {
  const db = testDb();
  const dir = mkdtempSync(join(tmpdir(), 'cog-'));
  const id = enqueueLeasedJob(db, 'dream.run', 'w1');
  db.prepare(`UPDATE jobs SET payload=? WHERE id=?`).run(
    JSON.stringify({ cron: '50 3 * * *' }),
    id,
  );
  const ch = fakeChild();
  spawnCognitionChild(db, getJob(db, id), {
    spawn: (() => ch) as never,
    userDataDir: dir,
    entryPath: () => '/x/e.ts',
  });
  assert.doesNotThrow(() => {
    ch.emit('error', new Error('spawn pnpm ENOENT'));
  });
  const row = getJob(db, id);
  assert.strictEqual(row.state, 'errored');
  assert.match(row.last_error ?? '', /child spawn error/);
  const alert = db
    .prepare(`SELECT key FROM alerts WHERE source='cognition' AND resolved_at IS NULL`)
    .get() as { key: string } | undefined;
  assert.strictEqual(alert?.key, 'spawn-fail:dream.run');
  const pending = db
    .prepare(`SELECT COUNT(*) n FROM jobs WHERE name='dream.run' AND state='pending'`)
    .get() as { n: number };
  assert.strictEqual(pending.n, 1, 'cron must be re-armed after an async spawn error');
  // lock released → a fresh spawn succeeds again
  const id2 = enqueueLeasedJob(db, 'dream.run', 'w1');
  assert.strictEqual(
    spawnCognitionChild(db, getJob(db, id2), {
      spawn: (() => fakeChild()) as never,
      userDataDir: dir,
      entryPath: () => '/x/e.ts',
    }),
    'detached',
  );
  closeDb(db);
});

test('exit watch is advisory: a zero-code exit is left alone', () => {
  const db = testDb();
  const dir = mkdtempSync(join(tmpdir(), 'cog-'));
  const id = enqueueLeasedJob(db, 'dream.run', 'w1');
  const ch = fakeChild();
  spawnCognitionChild(db, getJob(db, id), {
    spawn: (() => ch) as never,
    userDataDir: dir,
    entryPath: () => '/x/e.ts',
  });
  ch.emit('exit', 0);
  const row = getJob(db, id);
  assert.strictEqual(row.state, 'leased'); // untouched — a clean exit is not a spawn failure
  closeDb(db);
});

test('exit watch is advisory: does nothing if the row already moved on (child completed it)', () => {
  const db = testDb();
  const dir = mkdtempSync(join(tmpdir(), 'cog-'));
  const id = enqueueLeasedJob(db, 'dream.run', 'w1');
  const ch = fakeChild();
  spawnCognitionChild(db, getJob(db, id), {
    spawn: (() => ch) as never,
    userDataDir: dir,
    entryPath: () => '/x/e.ts',
  });
  // Simulate the child having already written its own completion before its
  // process actually exits (normal case: finish() runs, then process.exit()).
  db.prepare(`UPDATE jobs SET state='completed' WHERE id=?`).run(id);
  ch.emit('exit', 1);
  const row = getJob(db, id);
  assert.strictEqual(row.state, 'completed'); // watch must not stomp a row that moved on
  closeDb(db);
});

function openAlert(db: RobinDb, jobName: string): { resolved_at: string | null } | undefined {
  return db
    .prepare(
      `SELECT resolved_at FROM alerts WHERE source='cognition' AND key=? ORDER BY id DESC LIMIT 1`,
    )
    .get(`spawn-fail:${jobName}`) as { resolved_at: string | null } | undefined;
}

// Backlog #5: a spawn that survives the fast-fail window is a healthy spawn,
// and a healthy spawn should close out any spawn-fail incident left open by a
// PRIOR failed spawn — otherwise one transient failure pages forever even
// after the job recovers on its own. fastFailWindowMs is injected short so
// the test doesn't wait out the real 15s window.
test('spawn-success timer resolves a pre-existing spawn-fail alert once the window elapses cleanly', async () => {
  const db = testDb();
  const dir = mkdtempSync(join(tmpdir(), 'cog-'));
  const id = enqueueLeasedJob(db, 'dream.run', 'w1');
  recordAlert(db, {
    severity: 'warning',
    source: 'cognition',
    key: 'spawn-fail:dream.run',
    message: 'a prior spawn failure',
  });
  const ch = fakeChild();
  const r = spawnCognitionChild(db, getJob(db, id), {
    spawn: (() => ch) as never,
    userDataDir: dir,
    entryPath: () => '/x/e.ts',
    fastFailWindowMs: 20,
  });
  assert.strictEqual(r, 'detached');
  // No exit/error emitted — the spawn survives the window untouched.
  await sleep(80);
  const alert = openAlert(db, 'dream.run');
  assert.ok(alert, 'alert row should still exist');
  assert.ok(alert?.resolved_at, 'alert should be resolved by the healthy-spawn timer');
  closeDb(db);
});

test('spawn-success timer is a no-op when the spawn fast-failed within the window', async () => {
  const db = testDb();
  const dir = mkdtempSync(join(tmpdir(), 'cog-'));
  const id = enqueueLeasedJob(db, 'dream.run', 'w1');
  const ch = fakeChild();
  spawnCognitionChild(db, getJob(db, id), {
    spawn: (() => ch) as never,
    userDataDir: dir,
    entryPath: () => '/x/e.ts',
    fastFailWindowMs: 20,
  });
  ch.emit('exit', 1); // fast-fail: opens the alert and marks `handled`
  await sleep(80); // long enough for the (shortened) success timer to also fire
  const alert = openAlert(db, 'dream.run');
  assert.ok(alert, 'alert row should exist');
  assert.strictEqual(
    alert?.resolved_at,
    null,
    'a fast-failed spawn must not have its own just-opened alert closed by the success timer',
  );
  closeDb(db);
});
