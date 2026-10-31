import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeDb, openDb, type RobinDb } from '../../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../../brain/memory/migrations/index.ts';
import { orphanChildrenInvariant } from './orphan-children.ts';

function freshDb(): RobinDb {
  const dir = mkdtempSync(join(tmpdir(), 'robin-orphan-children-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

/** Insert a currently-leased jobs row claimed by `child:<pid>` (a live,
 *  still-renewing lease — the thing that makes a pid NOT wedged). */
function insertCurrentLease(db: RobinDb, name: string, pid: number): number {
  const r = db
    .prepare(
      `INSERT INTO jobs (name, trigger_kind, scheduled_at, state, claimed_by, leased_until)
       VALUES (?, 'cron', datetime('now'), 'leased', ?, ?)`,
    )
    .run(name, `child:${pid}`, new Date(Date.now() + 5 * 60_000).toISOString());
  return Number(r.lastInsertRowid);
}

/** Insert a jobs row carrying the reaper's breadcrumb for a given pid (mirrors
 *  what `recoverExpiredLeases` writes when it reclaims a stale lease). */
function insertReaperBreadcrumb(db: RobinDb, name: string, pid: number): number {
  const r = db
    .prepare(
      `INSERT INTO jobs (name, trigger_kind, scheduled_at, state, last_error)
       VALUES (?, 'cron', datetime('now'), 'pending', ?)`,
    )
    .run(name, `lease expired (worker=child:${pid}, due=2026-01-01T00:00:00.000Z)`);
  return Number(r.lastInsertRowid);
}

/** ms `minutesAgo` minutes before now — a `ChildProcess.startedAt` value. */
function startedMinutesAgo(m: number): number {
  return Date.now() - m * 60_000;
}

test('cognition.no_orphan_children: no live children → ok', async () => {
  const db = freshDb();
  const inv = orphanChildrenInvariant(db, {
    listChildPids: () => [],
  });
  const r = await inv.check();
  assert.equal(r.ok, true);
  closeDb(db);
});

test('cognition.no_orphan_children: young pid (under 5 min) → not flagged, regardless of lease state', async () => {
  const db = freshDb();
  const inv = orphanChildrenInvariant(db, {
    listChildPids: () => [{ pid: 4242, startedAt: startedMinutesAgo(1) }],
  });
  const r = await inv.check();
  assert.equal(r.ok, true, 'a pid younger than 5 minutes must never be flagged');
  closeDb(db);
});

test('cognition.no_orphan_children: old pid WITH a current lease → not flagged (still renewing normally)', async () => {
  const db = freshDb();
  insertCurrentLease(db, 'biographer.run', 4242);
  const inv = orphanChildrenInvariant(db, {
    listChildPids: () => [{ pid: 4242, startedAt: startedMinutesAgo(10) }],
  });
  const r = await inv.check();
  assert.equal(r.ok, true);
  closeDb(db);
});

test('cognition.no_orphan_children: old pid with NO current lease → flagged, lists the pid', async () => {
  const db = freshDb();
  const inv = orphanChildrenInvariant(db, {
    listChildPids: () => [{ pid: 4242, startedAt: startedMinutesAgo(10) }],
  });
  const r = await inv.check();
  assert.equal(r.ok, false);
  assert.match(r.message ?? '', /4242/);
  assert.ok(r.remediation, 'remediation should be present');
  closeDb(db);
});

test('cognition.no_orphan_children: old pid, no lease, but SOMEONE ELSE holds a current lease under a different pid → still flagged', async () => {
  const db = freshDb();
  insertCurrentLease(db, 'biographer.run', 9999); // unrelated pid's lease must not shadow 4242
  const inv = orphanChildrenInvariant(db, {
    listChildPids: () => [{ pid: 4242, startedAt: startedMinutesAgo(10) }],
  });
  const r = await inv.check();
  assert.equal(r.ok, false);
  closeDb(db);
});

test('cognition.no_orphan_children: reaper breadcrumb present → corroborated in the message, but absence alone is already sufficient', async () => {
  const db = freshDb();
  insertReaperBreadcrumb(db, 'biographer.run', 4242);
  const inv = orphanChildrenInvariant(db, {
    listChildPids: () => [{ pid: 4242, startedAt: startedMinutesAgo(10) }],
  });
  const r = await inv.check();
  assert.equal(r.ok, false);
  assert.match(r.message ?? '', /4242 \(reaper-confirmed\)/);
  closeDb(db);
});

test('cognition.no_orphan_children: no breadcrumb at all → still flagged (absence of a lease is sufficient on its own)', async () => {
  const db = freshDb();
  const inv = orphanChildrenInvariant(db, {
    listChildPids: () => [{ pid: 4242, startedAt: startedMinutesAgo(10) }],
  });
  const r = await inv.check();
  assert.equal(r.ok, false);
  assert.doesNotMatch(r.message ?? '', /reaper-confirmed/);
  closeDb(db);
});

test('cognition.no_orphan_children: multiple children — young/leased/wedged mix is filtered correctly', async () => {
  const db = freshDb();
  insertCurrentLease(db, 'dream.run', 2002); // wedged-looking age, but has a lease
  const inv = orphanChildrenInvariant(db, {
    listChildPids: () => [
      { pid: 1001, startedAt: startedMinutesAgo(10) }, // no lease → wedged
      { pid: 2002, startedAt: startedMinutesAgo(10) }, // has a lease → fine
      { pid: 3003, startedAt: startedMinutesAgo(2) }, // too young → fine
    ],
  });
  const r = await inv.check();
  assert.equal(r.ok, false);
  assert.match(r.message ?? '', /1 wedged/);
  assert.match(r.message ?? '', /1001/);
  assert.doesNotMatch(r.message ?? '', /2002/);
  assert.doesNotMatch(r.message ?? '', /3003/);
  closeDb(db);
});

test('cognition.no_orphan_children: repair re-verifies argv at kill time; a pid reused by a stranger since check() is never touched', async () => {
  const db = freshDb();
  let killCalls = 0;
  const inv = orphanChildrenInvariant(db, {
    listChildPids: () => [{ pid: 4242, startedAt: startedMinutesAgo(10) }],
    argvOf: () => '/usr/bin/some-unrelated-process --arg', // pid reused between check() and repair()
    kill: () => {
      killCalls++;
    },
    delay: async () => {},
  });
  await inv.repair?.();
  assert.equal(killCalls, 0, 'repair must never signal a pid that fails the live argv re-check');
  closeDb(db);
});

test('cognition.no_orphan_children: repair sends SIGTERM, waits 5s, and does NOT escalate once the process has died', async () => {
  const db = freshDb();
  const signals: Array<{ pid: number; signal: string }> = [];
  const delays: number[] = [];
  let diedDuringWait = false;
  const inv = orphanChildrenInvariant(db, {
    listChildPids: () => [{ pid: 5150, startedAt: startedMinutesAgo(10) }],
    argvOf: () => 'cognition-runner-entry',
    isAlive: (pid) => (pid === 5150 ? !diedDuringWait : false),
    kill: (pid, signal) => {
      signals.push({ pid, signal });
    },
    delay: async (ms) => {
      delays.push(ms);
      diedDuringWait = true;
    },
  });
  await inv.repair?.();
  assert.deepEqual(
    signals,
    [{ pid: 5150, signal: 'SIGTERM' }],
    'should NOT escalate to SIGKILL once the post-wait liveness check reports death',
  );
  assert.deepEqual(delays, [5000]);
  closeDb(db);
});

test('cognition.no_orphan_children: repair escalates to SIGKILL when still alive after the wait', async () => {
  const db = freshDb();
  const signals: Array<{ pid: number; signal: string }> = [];
  const inv = orphanChildrenInvariant(db, {
    listChildPids: () => [{ pid: 6161, startedAt: startedMinutesAgo(10) }],
    argvOf: () => 'cognition-runner-entry',
    isAlive: () => true, // stays alive through SIGTERM and the wait
    kill: (pid, signal) => {
      signals.push({ pid, signal });
    },
    delay: async () => {
      /* no real wait in tests */
    },
  });
  await inv.repair?.();
  assert.deepEqual(signals, [
    { pid: 6161, signal: 'SIGTERM' },
    { pid: 6161, signal: 'SIGKILL' },
  ]);
  closeDb(db);
});

test('cognition.no_orphan_children: multiple wedged children are all listed and all repaired', async () => {
  const db = freshDb();
  const killed: number[] = [];
  const inv = orphanChildrenInvariant(db, {
    listChildPids: () => [
      { pid: 1001, startedAt: startedMinutesAgo(10) },
      { pid: 1002, startedAt: startedMinutesAgo(20) },
    ],
    argvOf: () => 'cognition-runner-entry',
    isAlive: () => true,
    kill: (pid) => killed.push(pid),
    delay: async () => {},
  });
  const r = await inv.check();
  assert.equal(r.ok, false);
  assert.match(r.message ?? '', /2 wedged/);
  await inv.repair?.();
  // Each pid gets SIGTERM then SIGKILL (isAlive always true here) → 2 signals per pid.
  assert.deepEqual(
    killed.sort((a, b) => a - b),
    [1001, 1001, 1002, 1002],
  );
  closeDb(db);
});

test('cognition.no_orphan_children: production defaults are wired (all opts injectable-optional)', () => {
  const db = freshDb();
  // No opts at all — must not throw at factory time. We don't invoke check()/repair()
  // here (that would touch the real OS via execSync/process.kill).
  const inv = orphanChildrenInvariant(db);
  assert.equal(inv.name, 'cognition.no_orphan_children');
  assert.equal(inv.severity, 'warning');
  assert.ok(typeof inv.check === 'function');
  assert.ok(typeof inv.repair === 'function');
  closeDb(db);
});
