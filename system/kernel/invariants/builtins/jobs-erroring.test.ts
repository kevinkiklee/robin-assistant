import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeDb, openDb, type RobinDb } from '../../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../../brain/memory/migrations/index.ts';
import { jobsErroringInvariant } from './jobs-erroring.ts';

function freshDb(): RobinDb {
  const dir = mkdtempSync(join(tmpdir(), 'robin-jobs-erroring-'));
  const db = openDb(join(dir, 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

/** Insert a jobs row with the given state and an explicit created_at offset. */
function insertJob(db: RobinDb, name: string, state: string, createdAt: string): void {
  db.prepare(
    `INSERT INTO jobs (name, trigger_kind, scheduled_at, state, created_at)
     VALUES (?, 'cron', ?, ?, ?)`,
  ).run(name, createdAt, state, createdAt);
}

/** Insert an `errored` jobs row with explicit retry_count/last_error, for repair tests. */
function insertErroredJob(
  db: RobinDb,
  name: string,
  opts: { createdAt: string; retryCount: number; lastError: string },
): number {
  const r = db
    .prepare(
      `INSERT INTO jobs (name, trigger_kind, scheduled_at, state, retry_count, last_error, created_at)
       VALUES (?, 'cron', ?, 'errored', ?, ?, ?)`,
    )
    .run(name, opts.createdAt, opts.retryCount, opts.lastError, opts.createdAt);
  return Number(r.lastInsertRowid);
}

function jobState(db: RobinDb, id: number): string {
  return (db.prepare('SELECT state FROM jobs WHERE id = ?').get(id) as { state: string }).state;
}

// Offsets must be relative to the REAL clock: the invariant's window is
// `created_at > datetime('now','-1 day')`. A frozen anchor here turns into a
// time bomb — rows seeded "1 hour ago" drift out of the 24h window once the
// anchor date passes (observed 2026-06-12 with an anchor of 2026-06-10).

/** ISO string `hoursAgo` hours before now */
function hoursAgo(h: number): string {
  return new Date(Date.now() - h * 3_600_000).toISOString();
}

/** ISO string `daysAgo` days before now */
function daysAgo(d: number): string {
  return new Date(Date.now() - d * 86_400_000).toISOString();
}

test('jobs-erroring: empty table → ok', async () => {
  const db = freshDb();
  const inv = jobsErroringInvariant(db);
  const r = await inv.check();
  assert.equal(r.ok, true, JSON.stringify(r));
  closeDb(db);
});

test('jobs-erroring: one errored row in the last 24h → fires with name and count', async () => {
  const db = freshDb();
  insertJob(db, 'biographer', 'errored', hoursAgo(1));
  const inv = jobsErroringInvariant(db);
  const r = await inv.check();
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.match(r.message ?? '', /biographer/);
  assert.match(r.message ?? '', /1×/);
  assert.ok(r.remediation, 'remediation should be present');
  closeDb(db);
});

test('jobs-erroring: multiple errored rows for same job → count aggregated', async () => {
  const db = freshDb();
  insertJob(db, 'biographer', 'errored', hoursAgo(2));
  insertJob(db, 'biographer', 'errored', hoursAgo(3));
  insertJob(db, 'biographer', 'errored', hoursAgo(5));
  const inv = jobsErroringInvariant(db);
  const r = await inv.check();
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.match(r.message ?? '', /biographer errored 3×/);
  closeDb(db);
});

test('jobs-erroring: errored row 2 days old (outside 24h window) → ok', async () => {
  const db = freshDb();
  insertJob(db, 'biographer', 'errored', daysAgo(2));
  const inv = jobsErroringInvariant(db);
  const r = await inv.check();
  assert.equal(r.ok, true, JSON.stringify(r));
  closeDb(db);
});

test('jobs-erroring: completed rows in last 24h → ok', async () => {
  const db = freshDb();
  insertJob(db, 'biographer', 'completed', hoursAgo(1));
  insertJob(db, 'embedder', 'completed', hoursAgo(2));
  const inv = jobsErroringInvariant(db);
  const r = await inv.check();
  assert.equal(r.ok, true, JSON.stringify(r));
  closeDb(db);
});

test('jobs-erroring: multiple distinct errored jobs are listed in deterministic name order', async () => {
  const db = freshDb();
  // Insert out of alphabetical order; the GROUP BY ... ORDER BY name must sort them.
  insertJob(db, 'zebra', 'errored', hoursAgo(1));
  insertJob(db, 'alpha', 'errored', hoursAgo(2));
  insertJob(db, 'mango', 'errored', hoursAgo(3));
  const inv = jobsErroringInvariant(db);
  const r = await inv.check();
  assert.equal(r.ok, false, JSON.stringify(r));
  const msg = r.message ?? '';
  const order = ['alpha', 'mango', 'zebra'].map((n) => msg.indexOf(n));
  assert.ok(
    order[0] < order[1] && order[1] < order[2],
    `expected alpha < mango < zebra ordering, got: ${msg}`,
  );
  closeDb(db);
});

test('jobs-erroring: mix of errored and completed rows — only errored jobs flagged', async () => {
  const db = freshDb();
  insertJob(db, 'biographer', 'completed', hoursAgo(1));
  insertJob(db, 'embedder', 'errored', hoursAgo(2));
  const inv = jobsErroringInvariant(db);
  const r = await inv.check();
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.match(r.message ?? '', /embedder/);
  assert.doesNotMatch(r.message ?? '', /biographer/);
  closeDb(db);
});

test('jobs-erroring: repair resets a bounded transient-signature row to pending, leaves the retry-ceiling row and the unknown-signature row untouched', async () => {
  const db = freshDb();
  const okId = insertErroredJob(db, 'sync-a', {
    createdAt: hoursAgo(1),
    retryCount: 1,
    lastError: 'fetch failed: getaddrinfo ENOTFOUND',
  });
  const ceilingId = insertErroredJob(db, 'sync-b', {
    createdAt: hoursAgo(1),
    retryCount: 7,
    lastError: 'fetch failed: timeout',
  });
  const unknownId = insertErroredJob(db, 'sync-c', {
    createdAt: hoursAgo(1),
    retryCount: 1,
    lastError: 'TypeError: boom',
  });

  const inv = jobsErroringInvariant(db);
  assert.ok(inv.repair, 'invariant must define repair()');
  await inv.repair?.();

  assert.equal(
    jobState(db, okId),
    'pending',
    'known transient signature under the ceiling must reset',
  );
  assert.equal(
    jobState(db, ceilingId),
    'errored',
    'retry_count >= 5 must stay errored — hard ceiling',
  );
  assert.equal(jobState(db, unknownId), 'errored', 'unrecognized signature must stay errored');
  closeDb(db);
});

test('jobs-erroring: repair honors the retry_count < 5 boundary exactly (4 resets, 5 does not)', async () => {
  const db = freshDb();
  const underId = insertErroredJob(db, 'sync-d', {
    createdAt: hoursAgo(1),
    retryCount: 4,
    lastError: 'ECONNRESET',
  });
  const atId = insertErroredJob(db, 'sync-e', {
    createdAt: hoursAgo(1),
    retryCount: 5,
    lastError: 'ECONNRESET',
  });

  const inv = jobsErroringInvariant(db);
  await inv.repair?.();

  assert.equal(jobState(db, underId), 'pending', 'retry_count 4 < 5 must reset');
  assert.equal(
    jobState(db, atId),
    'errored',
    'retry_count 5 must NOT reset — ceiling is exclusive',
  );
  closeDb(db);
});

test('jobs-erroring: repair covers every documented transient signature', async () => {
  const db = freshDb();
  const signatures = [
    'fetch failed',
    'request timeout',
    'read ECONNRESET',
    'connect ETIMEDOUT',
    'socket hang up',
    'upstream responded 502',
    'upstream responded 503',
    'upstream responded 504',
  ];
  const ids = signatures.map((sig, i) =>
    insertErroredJob(db, `sync-sig-${i}`, {
      createdAt: hoursAgo(1),
      retryCount: 0,
      lastError: sig,
    }),
  );

  const inv = jobsErroringInvariant(db);
  await inv.repair?.();

  for (const [i, id] of ids.entries()) {
    assert.equal(jobState(db, id), 'pending', `signature "${signatures[i]}" must reset to pending`);
  }
  closeDb(db);
});

test('jobs-erroring: repair does not false-positive on "502" embedded mid-digit-run (word-boundary matching)', async () => {
  const db = freshDb();
  const id = insertErroredJob(db, 'sync-offset', {
    createdAt: hoursAgo(1),
    retryCount: 0,
    lastError: 'resumed at offset 15023',
  });
  const inv = jobsErroringInvariant(db);
  await inv.repair?.();
  assert.equal(jobState(db, id), 'errored', '"15023" must not word-boundary-match "502"');
  closeDb(db);
});

test('jobs-erroring: repair requeues a real "HTTP 502" signature', async () => {
  const db = freshDb();
  const id = insertErroredJob(db, 'sync-502', {
    createdAt: hoursAgo(1),
    retryCount: 0,
    lastError: 'HTTP 502 Bad Gateway',
  });
  const inv = jobsErroringInvariant(db);
  await inv.repair?.();
  assert.equal(jobState(db, id), 'pending');
  closeDb(db);
});

test('jobs-erroring: repair boundary cases — punctuation-bounded 503 matches, letter-adjacent 5034xx does not', async () => {
  const db = freshDb();
  const punctBounded = insertErroredJob(db, 'sync-punct', {
    createdAt: hoursAgo(1),
    retryCount: 0,
    lastError: 'upstream error(503): service unavailable',
  });
  const digitRun = insertErroredJob(db, 'sync-digitrun', {
    createdAt: hoursAgo(1),
    retryCount: 0,
    lastError: 'order id 5034421 not found',
  });
  const inv = jobsErroringInvariant(db);
  await inv.repair?.();
  assert.equal(jobState(db, punctBounded), 'pending', 'punctuation counts as a word boundary');
  assert.equal(
    jobState(db, digitRun),
    'errored',
    '"5034421" must not word-boundary-match "503" mid-digit-run',
  );
  closeDb(db);
});

test('jobs-erroring: repair skips a row whose last_error is NULL without throwing', async () => {
  const db = freshDb();
  const id = insertErroredJob(db, 'sync-null-error', {
    createdAt: hoursAgo(1),
    retryCount: 0,
    lastError: 'placeholder',
  });
  db.prepare('UPDATE jobs SET last_error = NULL WHERE id = ?').run(id);
  const inv = jobsErroringInvariant(db);
  await assert.doesNotReject(async () => inv.repair?.());
  assert.equal(jobState(db, id), 'errored');
  closeDb(db);
});

test('jobs-erroring: repair leaves errored rows outside the 24h window untouched', async () => {
  const db = freshDb();
  const oldId = insertErroredJob(db, 'sync-f', {
    createdAt: daysAgo(2),
    retryCount: 0,
    lastError: 'fetch failed',
  });

  const inv = jobsErroringInvariant(db);
  await inv.repair?.();

  assert.equal(jobState(db, oldId), 'errored', 'row older than the 24h window must not be touched');
  closeDb(db);
});
