import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { recordRepairFailure } from '../../kernel/runtime/repair-breaker.ts';
import { closeDb, openDb, type RobinDb } from '../memory/db.ts';
import { allMigrations, applyMigrations } from '../memory/migrations/index.ts';
import {
  artifactPath,
  type ReliabilityArtifact,
  remediationGoal,
  runReliabilityAudit,
} from './reliability-audit.ts';

const NOW = new Date('2026-08-11T12:00:00.000Z');
const now = () => NOW;
const H = 3_600_000;
const D = 24 * H;
/** Mirrors the implementation's NEVER_OK_AGE_HOURS sentinel (24*365) — kept as
 *  a local literal so the test doesn't need to export an internal constant. */
const NEVER_OK_AGE_HOURS = 24 * 365;

function isoAgo(ms: number): string {
  return new Date(NOW.getTime() - ms).toISOString();
}

/** `datetime('now')`-format string (space-separated, UTC) offset from NOW. */
function sqlAgo(ms: number): string {
  return new Date(NOW.getTime() - ms).toISOString().slice(0, 19).replace('T', ' ');
}

function freshEnv(): { db: RobinDb; userDataDir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'robin-reliability-audit-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return { db, userDataDir: dir };
}

function insertAlert(
  db: RobinDb,
  row: {
    source: string;
    key: string;
    firstSeenAt: string;
    resolvedAt?: string | null;
    outcome?: string | null;
    repairAttemptedAt?: string | null;
    escalatedAt?: string | null;
  },
): number {
  const r = db
    .prepare(
      `INSERT INTO alerts
         (severity, source, key, message, first_seen_at, last_seen_at, resolved_at, outcome, repair_attempted_at, escalated_at)
       VALUES ('warning', ?, ?, 'test', ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.source,
      row.key,
      row.firstSeenAt,
      row.firstSeenAt,
      row.resolvedAt ?? null,
      row.outcome ?? null,
      row.repairAttemptedAt ?? null,
      row.escalatedAt ?? null,
    );
  return Number(r.lastInsertRowid);
}

/** tz always pinned to 'UTC' — without an explicit tz, getNextRunAt resolves
 *  via the HOST's system timezone (resolveTz in cron.ts), which would make
 *  hour:minute-specific test crons non-deterministic across machines. */
function insertCronJob(
  db: RobinDb,
  opts: { name: string; scheduledAt: string; state: string; cron: string },
): void {
  db.prepare(
    `INSERT INTO jobs (name, trigger_kind, scheduled_at, state, payload) VALUES (?, 'cron', ?, ?, ?)`,
  ).run(opts.name, opts.scheduledAt, opts.state, JSON.stringify({ cron: opts.cron, tz: 'UTC' }));
}

function setKv(db: RobinDb, name: string, key: string, value: string): void {
  db.prepare(`INSERT INTO integration_state (integration_name, key, value) VALUES (?, ?, ?)`).run(
    name,
    key,
    value,
  );
}

function insertAgentUsage(
  db: RobinDb,
  opts: {
    surface: string;
    status: string;
    outcome?: string | null;
    ts: string;
    label?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO agent_usage (ts, surface, status, outcome, label) VALUES (?, ?, ?, ?, ?)`,
  ).run(opts.ts, opts.surface, opts.status, opts.outcome ?? null, opts.label ?? null);
}

test('reliability-audit: empty db is quiet — all sections empty/zero, no flags', () => {
  const { db, userDataDir } = freshEnv();
  const artifact = runReliabilityAudit(db, { userDataDir, now });
  assert.deepEqual(artifact.healed, []);
  assert.deepEqual(artifact.recurred, []);
  assert.deepEqual(artifact.needsHuman, []);
  assert.equal(artifact.silent.missedCrons.length, 0);
  assert.equal(artifact.silent.staleIntegrations.length, 0);
  assert.equal(artifact.silent.agentRunsWithoutOutcome, 0);
  assert.deepEqual(artifact.trends.flags, []);
  assert.equal(artifact.date, '2026-08-11'); // NOW is well inside the ET calendar day
  closeDb(db);
});

test('reliability-audit: a repaired-then-reopened incident becomes recurred, and the original row is stamped', () => {
  const { db, userDataDir } = freshEnv();
  const origId = insertAlert(db, {
    source: 'invariant',
    key: 'x.inv',
    firstSeenAt: sqlAgo(3 * H),
    resolvedAt: sqlAgo(2 * H), // within the trailing 24h
    outcome: 'repaired',
    repairAttemptedAt: sqlAgo(2.5 * H),
  });
  // Reopened 1h after the original resolved — well within the 24h reopen window.
  insertAlert(db, {
    source: 'invariant',
    key: 'x.inv',
    firstSeenAt: sqlAgo(1 * H),
  });

  const artifact = runReliabilityAudit(db, { userDataDir, now });

  assert.equal(artifact.healed.length, 0);
  assert.equal(artifact.recurred.length, 1);
  assert.equal(artifact.recurred[0].key, 'x.inv');
  assert.equal(artifact.recurred[0].source, 'invariant');
  assert.equal(artifact.recurred[0].firstClosedAt, sqlAgo(2 * H));
  assert.equal(artifact.recurred[0].reopenedAt, sqlAgo(1 * H));

  const row = db.prepare(`SELECT outcome FROM alerts WHERE id = ?`).get(origId) as {
    outcome: string;
  };
  assert.equal(row.outcome, 'recurred');
  closeDb(db);
});

test('reliability-audit: a repaired-and-quiet incident is healed via repair', () => {
  const { db, userDataDir } = freshEnv();
  insertAlert(db, {
    source: 'invariant',
    key: 'y.inv',
    firstSeenAt: sqlAgo(5 * H),
    resolvedAt: sqlAgo(4 * H),
    outcome: 'repaired',
    repairAttemptedAt: sqlAgo(4.5 * H),
  });

  const artifact = runReliabilityAudit(db, { userDataDir, now });

  assert.equal(artifact.recurred.length, 0);
  assert.equal(artifact.healed.length, 1);
  assert.deepEqual(artifact.healed[0], {
    key: 'y.inv',
    source: 'invariant',
    closedAt: sqlAgo(4 * H),
    via: 'repair',
  });
  closeDb(db);
});

test('reliability-audit: healed[] is ordered most-recently-resolved first', () => {
  const { db, userDataDir } = freshEnv();
  insertAlert(db, {
    source: 'invariant',
    key: 'older.inv',
    firstSeenAt: sqlAgo(4 * H),
    resolvedAt: sqlAgo(3 * H), // resolved earlier
    outcome: 'repaired',
    repairAttemptedAt: sqlAgo(3.5 * H),
  });
  insertAlert(db, {
    source: 'invariant',
    key: 'newer.inv',
    firstSeenAt: sqlAgo(2 * H),
    resolvedAt: sqlAgo(1 * H), // resolved more recently
    outcome: 'repaired',
    repairAttemptedAt: sqlAgo(1.5 * H),
  });

  const artifact = runReliabilityAudit(db, { userDataDir, now });

  assert.equal(artifact.healed.length, 2);
  assert.equal(artifact.healed[0].key, 'newer.inv');
  assert.equal(artifact.healed[1].key, 'older.inv');
  closeDb(db);
});

test('reliability-audit: repaired outside the trailing 24h is neither healed nor recurred', () => {
  const { db, userDataDir } = freshEnv();
  insertAlert(db, {
    source: 'invariant',
    key: 'old.inv',
    firstSeenAt: sqlAgo(3 * D),
    resolvedAt: sqlAgo(2 * D), // resolved 2 days ago — outside the 24h Q1 window
    outcome: 'repaired',
    repairAttemptedAt: sqlAgo(2 * D + H),
  });
  const artifact = runReliabilityAudit(db, { userDataDir, now });
  assert.equal(artifact.healed.length, 0);
  assert.equal(artifact.recurred.length, 0);
  closeDb(db);
});

test('reliability-audit: an open needs-human row carries fix text from the doctor-set map', () => {
  const { db, userDataDir } = freshEnv();
  insertAlert(db, {
    source: 'invariant',
    key: 'install.user_data_writable', // a real doctor invariant name
    firstSeenAt: sqlAgo(3 * D),
    outcome: 'needs-human',
    repairAttemptedAt: sqlAgo(3 * D - H),
    escalatedAt: sqlAgo(3 * D - 2 * H),
  });

  const artifact = runReliabilityAudit(db, { userDataDir, now });

  assert.equal(artifact.needsHuman.length, 1);
  const nh = artifact.needsHuman[0];
  assert.equal(nh.key, 'install.user_data_writable');
  assert.equal(nh.source, 'invariant');
  assert.equal(nh.since, sqlAgo(3 * D));
  assert.equal(nh.ageDays, 3);
  assert.match(nh.fix, /df -h/); // the real fix text from install-user-data-writable.ts
  closeDb(db);
});

test('reliability-audit: an unknown invariant key falls back to a generic fix note', () => {
  const { db, userDataDir } = freshEnv();
  insertAlert(db, {
    source: 'invariant',
    key: 'registry.invalid-depends-on', // real alert key, not in buildDoctorInvariants
    firstSeenAt: sqlAgo(D),
    outcome: 'needs-human',
  });
  const artifact = runReliabilityAudit(db, { userDataDir, now });
  assert.equal(artifact.needsHuman.length, 1);
  assert.match(artifact.needsHuman[0].fix, /no runbook entry/);
  closeDb(db);
});

test('reliability-audit: a resolved needs-human row is not surfaced (open incidents only)', () => {
  const { db, userDataDir } = freshEnv();
  insertAlert(db, {
    source: 'invariant',
    key: 'jobs.discoverable',
    firstSeenAt: sqlAgo(3 * D),
    resolvedAt: sqlAgo(H),
    outcome: 'needs-human',
  });
  const artifact = runReliabilityAudit(db, { userDataDir, now });
  assert.equal(artifact.needsHuman.length, 0);
  closeDb(db);
});

test('reliability-audit: a cron with a recoverable payload and zero actuals is flagged missed', () => {
  const { db, userDataDir } = freshEnv();
  // Fires every 5 minutes — plenty of expected occurrences in 24h — but the
  // only row in the last 7d is still pending, so actual (completed+errored) is 0.
  insertCronJob(db, {
    name: 'ghost.run',
    scheduledAt: isoAgo(H),
    state: 'pending',
    cron: '*/5 * * * *',
  });

  const artifact = runReliabilityAudit(db, { userDataDir, now });

  assert.equal(artifact.silent.missedCrons.length, 1);
  assert.equal(artifact.silent.missedCrons[0].name, 'ghost.run');
  assert.equal(artifact.silent.missedCrons[0].actual, 0);
  assert.ok(artifact.silent.missedCrons[0].expected > 0);
  closeDb(db);
});

test('reliability-audit: a cron with healthy actuals is not flagged', () => {
  const { db, userDataDir } = freshEnv();
  // Hourly cron: expect ~24 occurrences in the trailing 24h; seed a completed
  // row for every expected hour so actual keeps pace with expected.
  for (let i = 0; i < 24; i++) {
    insertCronJob(db, {
      name: 'healthy.run',
      scheduledAt: isoAgo(i * H),
      state: 'completed',
      cron: '0 * * * *',
    });
  }
  const artifact = runReliabilityAudit(db, { userDataDir, now });
  assert.equal(
    artifact.silent.missedCrons.find((m) => m.name === 'healthy.run'),
    undefined,
  );
  closeDb(db);
});

test('reliability-audit: a boot inside the trailing 24h applies 10% slack to expected', () => {
  const { db, userDataDir } = freshEnv();
  insertCronJob(db, {
    name: 'ghost.run',
    scheduledAt: isoAgo(H),
    state: 'pending',
    cron: '*/5 * * * *',
  });
  mkdirSync(join(userDataDir, 'state', 'runtime'), { recursive: true });
  writeFileSync(
    join(userDataDir, 'state', 'runtime', 'boots.json'),
    JSON.stringify([{ at: isoAgo(2 * H), class: 'crash' }]),
  );

  const withoutBoot = (() => {
    const env = freshEnv();
    insertCronJob(env.db, {
      name: 'ghost.run',
      scheduledAt: isoAgo(H),
      state: 'pending',
      cron: '*/5 * * * *',
    });
    const a = runReliabilityAudit(env.db, { userDataDir: env.userDataDir, now });
    closeDb(env.db);
    return a.silent.missedCrons[0].expected;
  })();

  const artifact = runReliabilityAudit(db, { userDataDir, now });
  assert.equal(artifact.silent.missedCrons[0].expected, Math.floor(withoutBoot * 0.9));
  closeDb(db);
});

test('reliability-audit: a genuine miss (expected>0, no completed/errored/leased rows at all) is still flagged', () => {
  // Don't over-fix: the leased/grace/clamp corrections must not blanket-suppress
  // a real missed cron. Same fixture as the "zero actuals" test above, restated
  // explicitly per the reviewer's ask for a dedicated "still flagged" case.
  const { db, userDataDir } = freshEnv();
  insertCronJob(db, {
    name: 'truly-missed.run',
    scheduledAt: isoAgo(H),
    state: 'pending', // never claimed, never leased, never completed
    cron: '*/5 * * * *',
  });
  const artifact = runReliabilityAudit(db, { userDataDir, now });
  const missed = artifact.silent.missedCrons.find((m) => m.name === 'truly-missed.run');
  assert.ok(missed, 'a genuine miss must still be flagged');
  assert.equal(missed?.actual, 0);
  assert.ok((missed?.expected ?? 0) > 0);
  closeDb(db);
});

test('reliability-audit: a leased (in-flight) row counts toward actual — not a phantom missed cron', () => {
  // Reproduces the self-flag bug: the audit's own cron (or a still-running
  // dream.run-style job) is 'leased', not yet 'completed', at the instant this
  // audit reads the jobs table. A decoy row from "yesterday" falls just
  // outside the 24h actual-window (the exact mechanism the reviewer
  // described) — the in-flight row is what must save this from a false flag.
  const { db, userDataDir } = freshEnv();
  const cron = '45 11 * * *'; // fires 15 min before NOW — comfortably inside the grace-trimmed walk
  insertCronJob(db, {
    name: 'inflight.run',
    scheduledAt: '2026-08-10T11:45:00.000Z', // yesterday's occurrence — outside now-24h
    state: 'completed',
    cron,
  });
  insertCronJob(db, {
    name: 'inflight.run',
    scheduledAt: '2026-08-11T11:45:00.000Z', // today's occurrence — currently running
    state: 'leased',
    cron,
  });

  const artifact = runReliabilityAudit(db, { userDataDir, now });
  assert.equal(
    artifact.silent.missedCrons.find((m) => m.name === 'inflight.run'),
    undefined,
    'an in-flight (leased) occurrence must not be counted as missed',
  );
  closeDb(db);
});

test('reliability-audit: an occurrence inside the grace period is not yet demanded to have a terminal state', () => {
  // A cron with real history (yesterday's completed row keeps the mid-window
  // clamp from kicking in) whose most recent occurrence fired 2 minutes ago
  // and is still 'pending' (ordinary claim latency, not a real miss).
  const { db, userDataDir } = freshEnv();
  const cron = '58 11 * * *';
  insertCronJob(db, {
    name: 'just-fired.run',
    scheduledAt: '2026-08-10T11:58:00.000Z', // yesterday — establishes history before now-24h
    state: 'completed',
    cron,
  });
  insertCronJob(db, {
    name: 'just-fired.run',
    scheduledAt: '2026-08-11T11:58:00.000Z', // 2 minutes before NOW
    state: 'pending',
    cron,
  });

  const artifact = runReliabilityAudit(db, { userDataDir, now });
  assert.equal(
    artifact.silent.missedCrons.find((m) => m.name === 'just-fired.run'),
    undefined,
    'an occurrence inside the grace period must not be flagged missed yet',
  );
  closeDb(db);
});

test('reliability-audit: a cron registered mid-window is only expected from its first appearance, not the full 24h', () => {
  const { db, userDataDir } = freshEnv();
  const cron = '0 * * * *'; // hourly
  // First-ever row 3h ago ("registration"), plus the two hourly occurrences
  // since. Without the mid-window clamp, the walk would assume a full 24h of
  // history (~22 expected hourly occurrences) against only 3 actuals —
  // falsely flagged (expected>=10, actual < expected*0.5).
  for (const scheduledAt of [
    '2026-08-11T09:00:00.000Z',
    '2026-08-11T10:00:00.000Z',
    '2026-08-11T11:00:00.000Z',
  ]) {
    insertCronJob(db, { name: 'newcron.run', scheduledAt, state: 'completed', cron });
  }

  const artifact = runReliabilityAudit(db, { userDataDir, now });
  assert.equal(
    artifact.silent.missedCrons.find((m) => m.name === 'newcron.run'),
    undefined,
    'a recently-registered cron must be judged only from its first appearance',
  );
  closeDb(db);
});

test('reliability-audit: a cron name with no recoverable payload is skipped, not thrown', () => {
  const { db, userDataDir } = freshEnv();
  db.prepare(
    `INSERT INTO jobs (name, trigger_kind, scheduled_at, state, payload) VALUES (?, 'cron', ?, 'pending', NULL)`,
  ).run('payloadless.run', isoAgo(H));
  assert.doesNotThrow(() => runReliabilityAudit(db, { userDataDir, now }));
  const artifact = runReliabilityAudit(db, { userDataDir, now });
  assert.equal(
    artifact.silent.missedCrons.find((m) => m.name === 'payloadless.run'),
    undefined,
  );
  closeDb(db);
});

test('reliability-audit: an integration with no ok in 24h is stale; a healthy one is not', () => {
  const { db, userDataDir } = freshEnv();
  setKv(db, 'whoop', 'last_attempt_at', isoAgo(2 * H));
  setKv(db, 'whoop', 'last_ok_at', isoAgo(30 * H)); // >24h old

  setKv(db, 'ebird', 'last_attempt_at', isoAgo(H));
  setKv(db, 'ebird', 'last_ok_at', isoAgo(H)); // fresh

  const artifact = runReliabilityAudit(db, { userDataDir, now });

  assert.equal(artifact.silent.staleIntegrations.length, 1);
  assert.equal(artifact.silent.staleIntegrations[0].name, 'whoop');
  assert.equal(artifact.silent.staleIntegrations[0].lastOkAt, isoAgo(30 * H));
  assert.ok(artifact.silent.staleIntegrations[0].ageHours > 24);
  closeDb(db);
});

test('reliability-audit: an integration with no recorded ok ever gets a finite ageHours sentinel, not Infinity', () => {
  const { db, userDataDir } = freshEnv();
  setKv(db, 'fresh-install', 'last_attempt_at', isoAgo(H));
  const artifact = runReliabilityAudit(db, { userDataDir, now });
  assert.equal(artifact.silent.staleIntegrations.length, 1);
  assert.equal(artifact.silent.staleIntegrations[0].lastOkAt, null);
  // Infinity would JSON.stringify to null and silently corrupt the on-disk
  // contract — must be a finite number.
  assert.equal(artifact.silent.staleIntegrations[0].ageHours, NEVER_OK_AGE_HOURS);
  assert.ok(Number.isFinite(artifact.silent.staleIntegrations[0].ageHours));
  closeDb(db);
});

test('reliability-audit: a non-empty staleIntegrations fixture round-trips through the on-disk JSON with a finite ageHours', () => {
  const { db, userDataDir } = freshEnv();
  setKv(db, 'fresh-install', 'last_attempt_at', isoAgo(H));
  const artifact = runReliabilityAudit(db, { userDataDir, now });

  const onDisk = JSON.parse(readFileSync(artifactPath(userDataDir, artifact.date), 'utf8'));
  assert.deepEqual(onDisk.silent.staleIntegrations, artifact.silent.staleIntegrations);
  assert.equal(onDisk.silent.staleIntegrations[0].ageHours, NEVER_OK_AGE_HOURS);
  assert.notEqual(onDisk.silent.staleIntegrations[0].ageHours, null);
  closeDb(db);
});

test('reliability-audit: fleet-labeled agentic-autonomous success rows with NULL outcome are counted; capped/timeout/error and non-fleet labels are not', () => {
  const { db, userDataDir } = freshEnv();
  insertAgentUsage(db, {
    surface: 'agentic-autonomous',
    status: 'success',
    outcome: null,
    label: 'D', // fleet handler → should have recorded an outcome
    ts: isoAgo(H),
  });
  insertAgentUsage(db, {
    surface: 'agentic-autonomous',
    status: 'success',
    outcome: 'did-work',
    label: 'G',
    ts: isoAgo(H),
  });
  insertAgentUsage(db, {
    surface: 'agentic-autonomous',
    status: 'capped',
    outcome: null,
    label: 'K',
    ts: isoAgo(H),
  });
  insertAgentUsage(db, {
    surface: 'agentic-autonomous',
    status: 'timeout',
    outcome: null,
    label: 'B',
    ts: isoAgo(H),
  });
  insertAgentUsage(db, {
    surface: 'agentic-autonomous',
    status: 'error',
    outcome: null,
    label: 'F',
    ts: isoAgo(H),
  });
  // Cognition agents (dream-synthesis, nightly critique): label themselves but
  // structurally never record an outcome — must NOT be counted.
  insertAgentUsage(db, {
    surface: 'agentic-autonomous',
    status: 'success',
    outcome: null,
    label: 'dream:health',
    ts: isoAgo(H),
  });
  insertAgentUsage(db, {
    surface: 'agentic-autonomous',
    status: 'success',
    outcome: null,
    label: 'critique',
    ts: isoAgo(H),
  });
  // No label at all: not a fleet run → must not be counted.
  insertAgentUsage(db, {
    surface: 'agentic-autonomous',
    status: 'success',
    outcome: null,
    ts: isoAgo(H),
  });
  // Different surface: must not be counted even with a NULL outcome.
  insertAgentUsage(db, {
    surface: 'agentic-on-demand',
    status: 'success',
    outcome: null,
    label: 'D',
    ts: isoAgo(H),
  });
  // Outside the 24h window: must not be counted.
  insertAgentUsage(db, {
    surface: 'agentic-autonomous',
    status: 'success',
    outcome: null,
    label: 'D',
    ts: isoAgo(2 * D),
  });

  const artifact = runReliabilityAudit(db, { userDataDir, now });
  assert.equal(artifact.silent.agentRunsWithoutOutcome, 1);
  closeDb(db);
});

test('reliability-audit: trends flag a key opened >=5 times in 7d', () => {
  const { db, userDataDir } = freshEnv();
  // alerts_open_unique allows at most one OPEN (resolved_at IS NULL) row per
  // (source,key) — resolve each so 5 same-key rows can coexist.
  for (let i = 0; i < 5; i++) {
    insertAlert(db, {
      source: 'invariant',
      key: 'z.inv',
      firstSeenAt: sqlAgo(i * H + D), // spread across the window, all within 7d
      resolvedAt: sqlAgo(i * H + D - 60_000),
    });
  }
  const artifact = runReliabilityAudit(db, { userDataDir, now });
  const perKey = artifact.trends.perKey.find((k) => k.key === 'z.inv');
  assert.ok(perKey, 'z.inv should appear in perKey');
  assert.equal(perKey?.opened7d, 5);
  assert.ok(artifact.trends.flags.some((f) => f.includes('z.inv') && f.includes('opened 5')));
  closeDb(db);
});

test('reliability-audit: trends flag palliative repair — gated on (repaired+recurred)>=3 and recurred-ratio>0.5', () => {
  const { db, userDataDir } = freshEnv();
  // 1 repaired, 2 recurred within the 7d window: attempts=3, ratio=2/3>0.5.
  // Only 3 total rows for this key, so opened7d=3 stays clear of the
  // opened>=5 flag — isolates the palliative-repair flag specifically.
  insertAlert(db, {
    source: 'invariant',
    key: 'flaky.inv',
    firstSeenAt: sqlAgo(2 * H + D),
    resolvedAt: sqlAgo(2 * H + D - 60_000),
    outcome: 'repaired',
  });
  insertAlert(db, {
    source: 'invariant',
    key: 'flaky.inv',
    firstSeenAt: sqlAgo(D),
    resolvedAt: sqlAgo(D - 60_000),
    outcome: 'recurred',
  });
  insertAlert(db, {
    source: 'invariant',
    key: 'flaky.inv',
    firstSeenAt: sqlAgo(D + 10 * 60_000),
    resolvedAt: sqlAgo(D + 10 * 60_000 - 60_000),
    outcome: 'recurred',
  });

  const artifact = runReliabilityAudit(db, { userDataDir, now });
  assert.ok(
    artifact.trends.flags.some((f) => f.includes('flaky.inv') && f.includes('palliative')),
    JSON.stringify(artifact.trends.flags),
  );
  closeDb(db);
});

test('reliability-audit: palliative flag fires even when ALL repairs recurred (repaired7d=0)', () => {
  const { db, userDataDir } = freshEnv();
  // Q1 rewrites a reopened incident's outcome from 'repaired' to 'recurred',
  // so a key whose repairs ALL recurred has repaired7d=0 — the old
  // `repaired7d >= 3` gate could never fire here. The fixed gate uses
  // repaired7d+recurred7d (attempts=3) with a recurred-ratio of 1.0.
  for (let i = 0; i < 3; i++) {
    insertAlert(db, {
      source: 'invariant',
      key: 'always-recurs.inv',
      firstSeenAt: sqlAgo((i + 1) * H + D),
      resolvedAt: sqlAgo((i + 1) * H + D - 60_000),
      outcome: 'recurred',
    });
  }
  const artifact = runReliabilityAudit(db, { userDataDir, now });
  const perKey = artifact.trends.perKey.find((k) => k.key === 'always-recurs.inv');
  assert.equal(perKey?.repaired7d, 0);
  assert.equal(perKey?.recurred7d, 3);
  assert.ok(
    artifact.trends.flags.some((f) => f.includes('always-recurs.inv') && f.includes('palliative')),
    JSON.stringify(artifact.trends.flags),
  );
  closeDb(db);
});

test('reliability-audit: trends surface a tripped repair breaker and flag it', () => {
  const { db, userDataDir } = freshEnv();
  recordRepairFailure(userDataDir, 'install.user_data_writable');
  recordRepairFailure(userDataDir, 'install.user_data_writable');

  const artifact = runReliabilityAudit(db, { userDataDir, now });

  assert.ok(artifact.trends.circuitBroken.includes('install.user_data_writable'));
  assert.ok(artifact.trends.flags.some((f) => f.includes('circuit broken')));
  closeDb(db);
});

test('reliability-audit: needsHuman non-empty always flags, even with a quiet 7d trend', () => {
  const { db, userDataDir } = freshEnv();
  insertAlert(db, {
    source: 'invariant',
    key: 'install.user_data_writable',
    firstSeenAt: sqlAgo(3 * D),
    outcome: 'needs-human',
  });
  const artifact = runReliabilityAudit(db, { userDataDir, now });
  assert.ok(artifact.trends.flags.some((f) => f.includes('needs-human')));
  closeDb(db);
});

test('reliability-audit: writes the artifact atomically at the documented path, matching the returned object', () => {
  const { db, userDataDir } = freshEnv();
  const artifact = runReliabilityAudit(db, { userDataDir, now });

  const expectedPath = artifactPath(userDataDir, artifact.date);
  assert.ok(existsSync(expectedPath));
  const onDisk = JSON.parse(readFileSync(expectedPath, 'utf8'));
  assert.deepEqual(onDisk, artifact);

  // No leftover tmp file.
  const runtimeDir = join(userDataDir, 'state', 'runtime');
  const leftoverTmp = readdirSync(runtimeDir).filter((f) => f.includes('.tmp-'));
  assert.deepEqual(leftoverTmp, []);
  closeDb(db);
});

test('reliability-audit: date and generatedAt reflect the injected clock, not the real one', () => {
  const { db, userDataDir } = freshEnv();
  const artifact = runReliabilityAudit(db, { userDataDir, now });
  assert.equal(artifact.generatedAt, NOW.toISOString());
  assert.equal(artifact.date, '2026-08-11');
  closeDb(db);
});

// --- Finding 1: mature-window late-recurrence pass ------------------------

test('reliability-audit: mature-window pass finds a late recurrence — resolved 30h ago, reopened 26h ago', () => {
  const { db, userDataDir } = freshEnv();
  const origId = insertAlert(db, {
    source: 'invariant',
    key: 'late.inv',
    firstSeenAt: sqlAgo(31 * H),
    resolvedAt: sqlAgo(30 * H), // in the mature [24h,48h) window, outside the primary [0,24h) window
    outcome: 'repaired',
    repairAttemptedAt: sqlAgo(30.5 * H),
  });
  // Reopened 26h ago — within 24h of the ORIGINAL resolved_at (30h ago), the
  // doctor-cadence-recurrence shape the primary pass can never see.
  insertAlert(db, {
    source: 'invariant',
    key: 'late.inv',
    firstSeenAt: sqlAgo(26 * H),
  });

  const artifact = runReliabilityAudit(db, { userDataDir, now });

  assert.equal(artifact.healed.length, 0);
  assert.equal(artifact.recurred.length, 1);
  assert.equal(artifact.recurred[0].key, 'late.inv');
  assert.equal(artifact.recurred[0].source, 'invariant');
  assert.equal(artifact.recurred[0].firstClosedAt, sqlAgo(30 * H));
  assert.equal(artifact.recurred[0].reopenedAt, sqlAgo(26 * H));

  const row = db.prepare(`SELECT outcome FROM alerts WHERE id = ?`).get(origId) as {
    outcome: string;
  };
  assert.equal(row.outcome, 'recurred');
  closeDb(db);
});

test('reliability-audit: a late recurrence already stamped is not re-examined or double-emitted', () => {
  const { db, userDataDir } = freshEnv();
  insertAlert(db, {
    source: 'invariant',
    key: 'late2.inv',
    firstSeenAt: sqlAgo(31 * H),
    resolvedAt: sqlAgo(30 * H),
    outcome: 'repaired',
    repairAttemptedAt: sqlAgo(30.5 * H),
  });
  insertAlert(db, {
    source: 'invariant',
    key: 'late2.inv',
    firstSeenAt: sqlAgo(26 * H),
  });

  const first = runReliabilityAudit(db, { userDataDir, now });
  assert.equal(first.recurred.filter((r) => r.key === 'late2.inv').length, 1);

  // Same db, same clock: the row is now outcome='recurred', so the WHERE
  // outcome='repaired' filter must exclude it on a second pass.
  const second = runReliabilityAudit(db, { userDataDir, now });
  assert.equal(
    second.recurred.filter((r) => r.key === 'late2.inv').length,
    0,
    'a row already stamped recurred must not be re-examined or double-emitted',
  );
  closeDb(db);
});

test('reliability-audit: mature-window pass leaves a still-quiet resolve untouched — not stamped, not emitted', () => {
  const { db, userDataDir } = freshEnv();
  const origId = insertAlert(db, {
    source: 'invariant',
    key: 'quiet-late.inv',
    firstSeenAt: sqlAgo(31 * H),
    resolvedAt: sqlAgo(30 * H), // matured window, but no reopen row exists anywhere
    outcome: 'repaired',
    repairAttemptedAt: sqlAgo(30.5 * H),
  });

  const artifact = runReliabilityAudit(db, { userDataDir, now });

  assert.equal(
    artifact.healed.length,
    0,
    'the mature pass must not add a no-reopen row to healed — only the primary pass populates healed',
  );
  assert.equal(artifact.recurred.length, 0);

  const row = db.prepare(`SELECT outcome FROM alerts WHERE id = ?`).get(origId) as {
    outcome: string;
  };
  assert.equal(row.outcome, 'repaired', 'outcome must remain untouched when no reopen is found');
  closeDb(db);
});

// --- Finding 2: Q2 silent-failure flags reach trends.flags -----------------

test('reliability-audit: Q2 missedCron flag reaches trends.flags', () => {
  const { db, userDataDir } = freshEnv();
  insertCronJob(db, {
    name: 'ghost.run',
    scheduledAt: isoAgo(H),
    state: 'pending',
    cron: '*/5 * * * *',
  });
  const artifact = runReliabilityAudit(db, { userDataDir, now });
  assert.equal(artifact.silent.missedCrons.length, 1);
  const { expected, actual } = artifact.silent.missedCrons[0];
  assert.ok(
    artifact.trends.flags.includes(
      `silent: cron ghost.run missed (expected ${expected}, ran ${actual})`,
    ),
    JSON.stringify(artifact.trends.flags),
  );
  closeDb(db);
});

test('reliability-audit: Q2 staleIntegration flag reaches trends.flags', () => {
  const { db, userDataDir } = freshEnv();
  setKv(db, 'whoop', 'last_attempt_at', isoAgo(2 * H));
  setKv(db, 'whoop', 'last_ok_at', isoAgo(30 * H));
  const artifact = runReliabilityAudit(db, { userDataDir, now });
  assert.equal(artifact.silent.staleIntegrations.length, 1);
  const { ageHours } = artifact.silent.staleIntegrations[0];
  assert.ok(
    artifact.trends.flags.includes(`silent: integration whoop stale ${ageHours}h`),
    JSON.stringify(artifact.trends.flags),
  );
  closeDb(db);
});

test('reliability-audit: Q2 agentRunsWithoutOutcome flag reaches trends.flags', () => {
  const { db, userDataDir } = freshEnv();
  insertAgentUsage(db, {
    surface: 'agentic-autonomous',
    status: 'success',
    outcome: null,
    label: 'D',
    ts: isoAgo(H),
  });
  const artifact = runReliabilityAudit(db, { userDataDir, now });
  assert.equal(artifact.silent.agentRunsWithoutOutcome, 1);
  assert.ok(
    artifact.trends.flags.includes('silent: 1 agent run(s) completed without an outcome record'),
    JSON.stringify(artifact.trends.flags),
  );
  closeDb(db);
});

test('reliability-audit: a quiet Q2 produces no silent: flags, even when a Q3 flag fires', () => {
  const { db, userDataDir } = freshEnv();
  // Trip a Q3 flag (opened >=5) with zero Q2 findings anywhere.
  for (let i = 0; i < 5; i++) {
    insertAlert(db, {
      source: 'invariant',
      key: 'z2.inv',
      firstSeenAt: sqlAgo(i * H + D),
      resolvedAt: sqlAgo(i * H + D - 60_000),
    });
  }
  const artifact = runReliabilityAudit(db, { userDataDir, now });
  assert.ok(artifact.trends.flags.some((f) => f.includes('z2.inv')));
  assert.equal(
    artifact.trends.flags.filter((f) => f.startsWith('silent:')).length,
    0,
    JSON.stringify(artifact.trends.flags),
  );
  closeDb(db);
});

test('reliability-audit: missedCron flags cap at 3 with an "...and K more" overflow line', () => {
  const { db, userDataDir } = freshEnv();
  for (let i = 0; i < 5; i++) {
    insertCronJob(db, {
      name: `ghost${i}.run`,
      scheduledAt: isoAgo(H),
      state: 'pending',
      cron: '*/5 * * * *',
    });
  }
  const artifact = runReliabilityAudit(db, { userDataDir, now });
  assert.equal(artifact.silent.missedCrons.length, 5);
  const cronFlags = artifact.trends.flags.filter((f) => f.startsWith('silent: cron '));
  assert.equal(cronFlags.length, 3, JSON.stringify(artifact.trends.flags));
  assert.ok(
    artifact.trends.flags.includes('silent: …and 2 more missed cron(s)'),
    JSON.stringify(artifact.trends.flags),
  );
  closeDb(db);
});

test('reliability-audit: staleIntegration flags cap at 3 with an "...and K more" overflow line', () => {
  const { db, userDataDir } = freshEnv();
  for (let i = 0; i < 5; i++) {
    setKv(db, `svc${i}`, 'last_attempt_at', isoAgo(2 * H));
    setKv(db, `svc${i}`, 'last_ok_at', isoAgo(30 * H));
  }
  const artifact = runReliabilityAudit(db, { userDataDir, now });
  assert.equal(artifact.silent.staleIntegrations.length, 5);
  const integrationFlags = artifact.trends.flags.filter((f) =>
    f.startsWith('silent: integration '),
  );
  assert.equal(integrationFlags.length, 3, JSON.stringify(artifact.trends.flags));
  assert.ok(
    artifact.trends.flags.includes('silent: …and 2 more stale integration(s)'),
    JSON.stringify(artifact.trends.flags),
  );
  closeDb(db);
});

test('reliability-audit: an autonomous run that hit SDK compaction is counted and flagged', () => {
  const { db, userDataDir } = freshEnv();
  const insert = db.prepare(
    `INSERT INTO agent_usage (ts, surface, status, outcome, compactions) VALUES (?, ?, ?, ?, ?)`,
  );
  // In window, compacted once — counted.
  insert.run(isoAgo(H), 'agentic-autonomous', 'success', 'did-work', 1);
  // In window, no compaction — not counted.
  insert.run(isoAgo(2 * H), 'agentic-autonomous', 'success', 'did-work', 0);
  // Outside the 24h window — not counted.
  insert.run(isoAgo(2 * D), 'agentic-autonomous', 'success', 'did-work', 3);

  const artifact = runReliabilityAudit(db, { userDataDir, now });
  assert.equal(artifact.silent.agentRunsCompacted, 1);
  assert.ok(
    artifact.trends.flags.includes(
      'silent: 1 agent run(s) hit context compaction — output written from a summary, not the prompt',
    ),
    JSON.stringify(artifact.trends.flags),
  );
  closeDb(db);
});

test('reliability-audit: zero compacted runs adds no compaction flag', () => {
  const { db, userDataDir } = freshEnv();
  const artifact = runReliabilityAudit(db, { userDataDir, now });
  assert.equal(artifact.silent.agentRunsCompacted, 0);
  assert.ok(!artifact.trends.flags.some((f) => f.includes('context compaction')));
  closeDb(db);
});

// ── remediationGoal (auto-fix hand-off to K, 2026-10-31) ──────────────────────

function quietArtifact(): ReliabilityArtifact {
  return {
    date: '2026-10-31',
    generatedAt: '2026-10-31T08:00:00.000Z',
    healed: [],
    recurred: [],
    needsHuman: [],
    silent: {
      missedCrons: [],
      staleIntegrations: [],
      agentRunsWithoutOutcome: 0,
      agentRunsCompacted: 0,
    },
    trends: { perKey: [], circuitBroken: [], flags: [] },
  };
}

test('remediationGoal: a quiet audit asks for nothing', () => {
  assert.equal(remediationGoal(quietArtifact()), null);
});

test('remediationGoal: needs-human first, recurrences de-duplicated, uncovered flags appended', () => {
  const a = quietArtifact();
  a.needsHuman = [
    {
      key: 'jobs.not_erroring',
      source: 'invariant',
      since: '2026-10-29',
      ageDays: 1,
      fix: 'Run robin doctor.',
    },
  ];
  a.recurred = [
    { key: 'integrations.staleness', source: 'invariant', firstClosedAt: 'a', reopenedAt: 'b' },
    { key: 'integrations.staleness', source: 'invariant', firstClosedAt: 'c', reopenedAt: 'd' },
  ];
  a.silent.staleIntegrations = [{ name: 'photowalks', lastOkAt: null, ageHours: 43 }];
  a.trends.flags = [
    'integrations.staleness: palliative repair — 6/8 repairs recurred',
    'daemon.heartbeating: opened 32x in the last 7 days',
  ];
  const g = remediationGoal(a) ?? '';
  const lines = g.split('\n').filter((l) => l.startsWith('- '));
  assert.match(
    lines[0] ?? '',
    /^- NEEDS FIX: jobs\.not_erroring \(open 1d\)\. Runbook: Run robin doctor\./,
  );
  assert.equal(lines.filter((l) => l.includes('RECURRING: integrations.staleness')).length, 1);
  assert.ok(lines.some((l) => l === '- STALE: integration photowalks (43h).'));
  assert.ok(
    lines.some((l) => l.startsWith('- FLAG: daemon.heartbeating')),
    'uncovered flag kept',
  );
  assert.ok(
    !lines.some((l) => l.startsWith('- FLAG: integrations.staleness')),
    'covered flag dropped',
  );
  assert.match(g, /with a test that fails without the fix/);
});

test('remediationGoal: carries the last week of auto-fix history so K builds on it', () => {
  const a = quietArtifact();
  a.recurred = [
    { key: 'integrations.staleness', source: 'invariant', firstClosedAt: 'a', reopenedAt: 'b' },
  ];
  const g =
    remediationGoal(a, [
      {
        ts: '2026-10-30T10:00:00.000Z',
        branch: 'agent/x',
        landed: true,
        reason: 'landed as e0f47c7',
        files: ['system/kernel/invariants/builtins/integration-staleness.ts'],
      },
    ]) ?? '';
  assert.match(g, /Auto-fix history, last 7 days/);
  assert.match(
    g,
    /- 2026-10-30 landed agent\/x: landed as e0f47c7 \[system\/kernel\/invariants\/builtins\/integration-staleness\.ts\]/,
  );
  assert.doesNotMatch(remediationGoal(a) ?? '', /Auto-fix history/, 'no history → no section');
});
