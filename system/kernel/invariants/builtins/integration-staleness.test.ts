import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeDb, openDb, type RobinDb } from '../../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../../brain/memory/migrations/index.ts';
import { buildContext } from '../../../integrations/_runtime/context.ts';
import { tickWithRetryAndHeartbeat } from '../../../integrations/_runtime/scheduler-glue.ts';
import type { TickResult } from '../../../integrations/_runtime/types.ts';
import { createLogger } from '../../../lib/logging/logger.ts';
import { type Policies, policiesSchema } from '../../config/schema.ts';
import {
  integrationStalenessInvariant,
  integrationUnreachableInvariant,
  isNetworkClassError,
  isUpstreamClassSkip,
  type ScheduledIntegration,
} from './integration-staleness.ts';

function freshDb(): RobinDb {
  const dir = mkdtempSync(join(tmpdir(), 'robin-staleness-'));
  const db = openDb(join(dir, 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

/** Upsert one integration_state KV row at a fixed updated_at. */
function setKv(db: RobinDb, integration: string, key: string, value: string) {
  db.prepare(
    `INSERT INTO integration_state (integration_name, key, value, updated_at)
     VALUES (?, ?, ?, '2026-01-01T00:00:00.000Z')
     ON CONFLICT(integration_name, key) DO UPDATE SET value = excluded.value`,
  ).run(integration, key, value);
}

// Fixed clock. A 4h-cadence integration: warnAt = 12h, critAt = 40h.
const NOW = new Date('2026-06-10T12:00:00.000Z');
const now = () => NOW;
const isoAgo = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const H = 3_600_000;

const FOUR_HOURLY: ScheduledIntegration = { name: 'whoop', cron: '0 */4 * * *' };

function policies(raw: Record<string, unknown> = {}): Policies {
  return policiesSchema.parse(raw);
}

function makeInv(db: RobinDb, integrations: ScheduledIntegration[], p: Policies) {
  return integrationStalenessInvariant(db, {
    integrations: () => integrations,
    policies: () => p,
    now,
  });
}

/** Fresh temp boots.json path — never the real instance's boot history. */
function freshBootsPath(): string {
  const d = mkdtempSync(join(tmpdir(), 'robin-staleness-boots-'));
  return join(d, 'boots.json');
}

function writeBoots(bootsPath: string, entries: Array<{ at: string; class?: string }>): void {
  writeFileSync(bootsPath, JSON.stringify(entries));
}

test('staleness: healthy — fresh last_ok_at → ok', async () => {
  const db = freshDb();
  setKv(db, 'whoop', 'last_attempt_at', isoAgo(H));
  setKv(db, 'whoop', 'last_ok_at', isoAgo(H));
  setKv(db, 'whoop', 'consecutive_errors', '0');
  const r = await makeInv(db, [FOUR_HOURLY], policies()).check();
  assert.equal(r.ok, true, JSON.stringify(r));
  closeDb(db);
});

test('staleness: warning at >3× cadence (last_ok_at 13h ago for a 4h integration)', async () => {
  const db = freshDb();
  setKv(db, 'whoop', 'last_attempt_at', isoAgo(H));
  setKv(db, 'whoop', 'last_ok_at', isoAgo(13 * H));
  setKv(db, 'whoop', 'consecutive_errors', '0');
  const r = await makeInv(db, [FOUR_HOURLY], policies()).check();
  assert.equal(r.ok, false);
  assert.match(r.message ?? '', /whoop/);
  assert.doesNotMatch(r.message ?? '', /CRITICAL/, 'warning-level, not critical');
  closeDb(db);
});

test('staleness: critical marker at >10× cadence (41h ago)', async () => {
  const db = freshDb();
  setKv(db, 'whoop', 'last_attempt_at', isoAgo(H));
  setKv(db, 'whoop', 'last_ok_at', isoAgo(41 * H));
  setKv(db, 'whoop', 'consecutive_errors', '0');
  const r = await makeInv(db, [FOUR_HOURLY], policies()).check();
  assert.equal(r.ok, false);
  assert.match(r.message ?? '', /CRITICAL/);
  assert.match(r.message ?? '', /whoop/);
  closeDb(db);
});

test('staleness: zero-ingest healthy — fresh last_ok_at, ancient last_ingest_at → ok', async () => {
  const db = freshDb();
  setKv(db, 'whoop', 'last_attempt_at', isoAgo(H));
  setKv(db, 'whoop', 'last_ok_at', isoAgo(H)); // succeeds every tick…
  setKv(db, 'whoop', 'last_ingest_at', isoAgo(30 * 24 * H)); // …but no new data for 30 days
  setKv(db, 'whoop', 'consecutive_errors', '0');
  const r = await makeInv(db, [FOUR_HOURLY], policies()).check();
  assert.equal(r.ok, true, 'staleness is about successful ticks, not ingest volume');
  closeDb(db);
});

test('staleness: skip-streak — consecutive_skips=3 surfaces the skip reason verbatim', async () => {
  const db = freshDb();
  setKv(db, 'whoop', 'last_attempt_at', isoAgo(H));
  setKv(db, 'whoop', 'last_ok_at', isoAgo(H)); // recent ok, but…
  setKv(db, 'whoop', 'consecutive_skips', '3');
  setKv(db, 'whoop', 'last_skip_reason', 'GMAIL_REFRESH_TOKEN not set');
  const r = await makeInv(db, [FOUR_HOURLY], policies()).check();
  assert.equal(r.ok, false);
  assert.match(r.message ?? '', /GMAIL_REFRESH_TOKEN not set/);
  closeDb(db);
});

test('staleness: exempt via policies override → ok despite ancient last_ok_at', async () => {
  const db = freshDb();
  setKv(db, 'whoop', 'last_attempt_at', isoAgo(H));
  setKv(db, 'whoop', 'last_ok_at', isoAgo(100 * H));
  setKv(db, 'whoop', 'consecutive_errors', '0');
  const p = policies({ alerts: { staleness: { whoop: { exempt: true } } } });
  const r = await makeInv(db, [FOUR_HOURLY], p).check();
  assert.equal(r.ok, true);
  closeDb(db);
});

test('staleness: suppressed when power.state is paused (even with ancient last_ok_at)', async () => {
  const db = freshDb();
  setKv(db, 'whoop', 'last_attempt_at', isoAgo(100 * H));
  setKv(db, 'whoop', 'last_ok_at', isoAgo(100 * H));
  setKv(db, 'whoop', 'consecutive_errors', '0');
  const p = policies({ power: { state: 'paused' } });
  const r = await makeInv(db, [FOUR_HOURLY], p).check();
  assert.equal(r.ok, true, 'ticks are not running while paused — nothing to judge');
  closeDb(db);
});

test('staleness: suppressed when network.mode is offline', async () => {
  const db = freshDb();
  setKv(db, 'whoop', 'last_attempt_at', isoAgo(100 * H));
  setKv(db, 'whoop', 'last_ok_at', isoAgo(100 * H));
  setKv(db, 'whoop', 'consecutive_errors', '0');
  const p = policies({ network: { mode: 'offline' } });
  const r = await makeInv(db, [FOUR_HOURLY], p).check();
  assert.equal(r.ok, true, 'ticks are expected to skip offline');
  closeDb(db);
});

test('staleness: grace — power resumed 10min ago, 4h cadence → ok', async () => {
  const db = freshDb();
  setKv(db, 'whoop', 'last_attempt_at', isoAgo(100 * H));
  setKv(db, 'whoop', 'last_ok_at', isoAgo(100 * H));
  setKv(db, 'whoop', 'consecutive_errors', '0');
  // Resumed less than one cadence (4h) ago: give the integration its first cycle
  // to catch up before judging staleness.
  const p = policies({ power: { state: 'active', since: isoAgo(10 * 60_000) } });
  const r = await makeInv(db, [FOUR_HOURLY], p).check();
  assert.equal(r.ok, true);
  closeDb(db);
});

test('staleness: never-ticked integration (no rows) → ok (fresh install)', async () => {
  const db = freshDb();
  // No integration_state rows at all for whoop.
  const r = await makeInv(db, [FOUR_HOURLY], policies()).check();
  assert.equal(r.ok, true);
  closeDb(db);
});

test('staleness: transition — last_attempt_at fresh, no last_ok_at, consecutive_errors=0 → ok', async () => {
  const db = freshDb();
  // Post-deploy transient: last_ok_at not yet written, but the integration is
  // ticking cleanly (no errors). Must NOT false-alarm.
  setKv(db, 'whoop', 'last_attempt_at', isoAgo(H));
  setKv(db, 'whoop', 'consecutive_errors', '0');
  const r = await makeInv(db, [FOUR_HOURLY], policies()).check();
  assert.equal(r.ok, true, 'healthy-but-no-last_ok_at falls back to last_attempt_at');
  closeDb(db);
});

test('staleness: transition — no last_ok_at but consecutive_errors>0 → flagged (age = Infinity)', async () => {
  const db = freshDb();
  // It ticks but never succeeds: last_attempt_at exists, no last_ok_at, errors > 0.
  setKv(db, 'whoop', 'last_attempt_at', isoAgo(H));
  setKv(db, 'whoop', 'consecutive_errors', '2');
  const r = await makeInv(db, [FOUR_HOURLY], policies()).check();
  assert.equal(r.ok, false, 'erroring-with-no-success is stale regardless of last_attempt_at');
  assert.match(r.message ?? '', /whoop/);
  closeDb(db);
});

test('staleness: repair — boot within the staleness window + no skip/error streak → forces one tick', async () => {
  const db = freshDb();
  setKv(db, 'whoop', 'last_attempt_at', isoAgo(H));
  setKv(db, 'whoop', 'last_ok_at', isoAgo(13 * H)); // stale: >3x cadence
  setKv(db, 'whoop', 'consecutive_errors', '0');
  setKv(db, 'whoop', 'consecutive_skips', '0');

  const bootsPath = freshBootsPath();
  // Boot recorded AFTER whoop's last_ok_at (13h ago) — inside the window, and
  // past the 2×cadence (8h) startup grace so check() judges it at all.
  writeBoots(bootsPath, [{ at: isoAgo(9 * H), class: 'crash' }]);

  const ticked: string[] = [];
  const inv = integrationStalenessInvariant(db, {
    integrations: () => [FOUR_HOURLY],
    policies: () => policies(),
    now,
    bootsPath,
    forceTick: async (name) => {
      ticked.push(name);
    },
  });

  // Sanity: the check itself must actually be failing for this integration.
  const pre = await inv.check();
  assert.equal(pre.ok, false, JSON.stringify(pre));

  await inv.repair?.();
  assert.deepStrictEqual(ticked, ['whoop']);
  closeDb(db);
});

test('staleness: repair — no recent boot → no-op (forceTick never called)', async () => {
  const db = freshDb();
  setKv(db, 'whoop', 'last_attempt_at', isoAgo(H));
  setKv(db, 'whoop', 'last_ok_at', isoAgo(13 * H));
  setKv(db, 'whoop', 'consecutive_errors', '0');
  setKv(db, 'whoop', 'consecutive_skips', '0');

  // No boots.json written at all — file simply doesn't exist.
  const bootsPath = freshBootsPath();

  const ticked: string[] = [];
  const inv = integrationStalenessInvariant(db, {
    integrations: () => [FOUR_HOURLY],
    policies: () => policies(),
    now,
    bootsPath,
    forceTick: async (name) => {
      ticked.push(name);
    },
  });

  await inv.repair?.();
  assert.deepStrictEqual(ticked, [], 'no recorded boot means condition (a) can never hold');
  closeDb(db);
});

test('staleness: repair — boot exists but predates the staleness (last_ok_at is newer) → no-op', async () => {
  const db = freshDb();
  setKv(db, 'whoop', 'last_attempt_at', isoAgo(H));
  setKv(db, 'whoop', 'last_ok_at', isoAgo(13 * H));
  setKv(db, 'whoop', 'consecutive_errors', '0');
  setKv(db, 'whoop', 'consecutive_skips', '0');

  const bootsPath = freshBootsPath();
  // Boot is OLDER than last_ok_at — no restart since the integration last
  // succeeded, so a forced tick wouldn't be addressing a plausible cause.
  writeBoots(bootsPath, [{ at: isoAgo(20 * H), class: 'crash' }]);

  const ticked: string[] = [];
  const inv = integrationStalenessInvariant(db, {
    integrations: () => [FOUR_HOURLY],
    policies: () => policies(),
    now,
    bootsPath,
    forceTick: async (name) => {
      ticked.push(name);
    },
  });

  await inv.repair?.();
  assert.deepStrictEqual(ticked, []);
  closeDb(db);
});

test('staleness: repair — a live skip or error streak excludes the integration even with a boot in-window', async () => {
  const db = freshDb();
  const bootsPath = freshBootsPath();
  writeBoots(bootsPath, [{ at: isoAgo(2 * H), class: 'crash' }]);

  // whoop is stale and skipping — repair must not force-tick it (skip streak
  // means the tick will just skip again; not false-positive-safe).
  setKv(db, 'whoop', 'last_attempt_at', isoAgo(H));
  setKv(db, 'whoop', 'last_ok_at', isoAgo(13 * H));
  setKv(db, 'whoop', 'consecutive_errors', '0');
  setKv(db, 'whoop', 'consecutive_skips', '3');

  const ticked: string[] = [];
  const inv = integrationStalenessInvariant(db, {
    integrations: () => [FOUR_HOURLY],
    policies: () => policies(),
    now,
    bootsPath,
    forceTick: async (name) => {
      ticked.push(name);
    },
  });

  await inv.repair?.();
  assert.deepStrictEqual(ticked, [], 'a skip streak must exclude the integration from force-tick');
  closeDb(db);
});

test('staleness: repair caps at 3 integrations, picking the stalest first', async () => {
  const db = freshDb();
  const bootsPath = freshBootsPath();
  writeBoots(bootsPath, [{ at: isoAgo(2 * H), class: 'crash' }]);

  const names = ['a', 'b', 'c', 'd'];
  const ages = [50 * H, 30 * H, 90 * H, 15 * H]; // c is stalest, then a, then b, then d
  const integrations: ScheduledIntegration[] = names.map((name) => ({ name, cron: '0 */4 * * *' }));
  for (const [i, name] of names.entries()) {
    setKv(db, name, 'last_attempt_at', isoAgo(H));
    setKv(db, name, 'last_ok_at', isoAgo(ages[i]));
    setKv(db, name, 'consecutive_errors', '0');
    setKv(db, name, 'consecutive_skips', '0');
  }

  const ticked: string[] = [];
  const inv = integrationStalenessInvariant(db, {
    integrations: () => integrations,
    policies: () => policies(),
    now,
    bootsPath,
    forceTick: async (name) => {
      ticked.push(name);
    },
  });

  await inv.repair?.();
  assert.equal(ticked.length, 3, 'repair must cap at 3 integrations per invocation');
  assert.deepStrictEqual(ticked, ['c', 'a', 'b'], 'must force-tick the 3 stalest, stalest first');
  closeDb(db);
});

test('staleness: repair — a successful forced tick through the real heartbeat-writing wrapper clears the staleness, so the post-repair re-check passes', async () => {
  const db = freshDb();
  // Real wall-clock timestamps (not the fixed `now` helper): the armored
  // wrapper's heartbeat write (writeHeartbeat in scheduler-glue.ts) stamps
  // last_ok_at with the real `new Date()`, so the invariant's own clock must
  // also be the real one for the post-repair re-check to see it as fresh.
  const realNow = Date.now();
  const realAgo = (ms: number) => new Date(realNow - ms).toISOString();

  setKv(db, 'whoop', 'last_attempt_at', realAgo(H));
  setKv(db, 'whoop', 'last_ok_at', realAgo(13 * H)); // stale: >3x the 4h cadence
  setKv(db, 'whoop', 'consecutive_errors', '0');
  setKv(db, 'whoop', 'consecutive_skips', '0');

  const bootsPath = freshBootsPath();
  // After last_ok_at, but past the 2×cadence (8h) startup grace.
  writeBoots(bootsPath, [{ at: realAgo(9 * H), class: 'crash' }]);

  const log = createLogger({ module: 'test' });
  const fakeModule = {
    tick: async (): Promise<TickResult> => ({ status: 'ok', ingested: 1 }),
  };

  const inv = integrationStalenessInvariant(db, {
    integrations: () => [FOUR_HOURLY],
    policies: () => policies(),
    // No `now` override here — defaults to the real clock, matching the real
    // clock the heartbeat write uses.
    bootsPath,
    // Drive the repair through the REAL armored wrapper (not the disk-loading
    // production default) against a fake module and the real test db — this
    // is what actually exercises the heartbeat write the reviewer flagged as
    // missing from a bare `module.tick(ctx)` call.
    forceTick: async (name) => {
      const ctx = buildContext(name, db, null);
      await tickWithRetryAndHeartbeat(name, fakeModule, ctx, log);
    },
  });

  const pre = await inv.check();
  assert.equal(pre.ok, false, 'sanity: must be flagged stale before repair');

  await inv.repair?.();

  const post = await inv.check();
  assert.equal(
    post.ok,
    true,
    'a successful forced tick must update last_ok_at (via the heartbeat write) so the re-check passes — the incident can now resolve instead of climbing toward a false escalation',
  );
  closeDb(db);
});

// --- startup / wake grace + network-class split (2026-10 alert-noise fix) ---

const FIVE_MIN: ScheduledIntegration = { name: 'claude_code', cron: '*/5 * * * *' };

function staleClaudeCode(db: RobinDb): void {
  // 20 min since last success on a 5-min cadence: >3× → 'stale 0h' pre-fix.
  setKv(db, 'claude_code', 'last_attempt_at', isoAgo(20 * 60_000));
  setKv(db, 'claude_code', 'last_ok_at', isoAgo(20 * 60_000));
  setKv(db, 'claude_code', 'consecutive_errors', '0');
}

test('staleness: startup grace — no verdict within 2× cadence of daemon start', async () => {
  const db = freshDb();
  staleClaudeCode(db);
  const mk = (startedAgoMs: number) =>
    integrationStalenessInvariant(db, {
      integrations: () => [FIVE_MIN],
      policies: () => policies(),
      now,
      startedAt: () => NOW.getTime() - startedAgoMs,
    });
  assert.equal((await mk(8 * 60_000).check()).ok, true, 'started 8 min ago (< 10 min grace)');
  assert.equal((await mk(11 * 60_000).check()).ok, false, 'started 11 min ago → judged');
  closeDb(db);
});

test('staleness: startup grace defaults to the last boot in boots.json', async () => {
  const db = freshDb();
  staleClaudeCode(db);
  const bootsPath = freshBootsPath();
  writeBoots(bootsPath, [{ at: isoAgo(3 * 60_000), class: 'clean' }]);
  const inv = integrationStalenessInvariant(db, {
    integrations: () => [FIVE_MIN],
    policies: () => policies(),
    now,
    bootsPath,
  });
  assert.equal((await inv.check()).ok, true);
  closeDb(db);
});

test('staleness: wake grace — a >5 min gap between checks (sleep) suppresses the next 2 cadences', async () => {
  const db = freshDb();
  let t = NOW.getTime();
  const inv = () =>
    integrationStalenessInvariant(db, {
      integrations: () => [FIVE_MIN],
      policies: () => policies(),
      now: () => new Date(t),
      startedAt: () => null,
    });
  const staleAt = (ms: number) => {
    setKv(db, 'claude_code', 'last_attempt_at', new Date(ms - 20 * 60_000).toISOString());
    setKv(db, 'claude_code', 'last_ok_at', new Date(ms - 20 * 60_000).toISOString());
    setKv(db, 'claude_code', 'consecutive_errors', '0');
  };
  staleAt(t);
  assert.equal((await inv().check()).ok, false, 'awake + stale → flagged');
  t += 60_000;
  assert.equal((await inv().check()).ok, false, 'normal 60s cadence → still flagged');
  t += 8 * 3_600_000; // laptop slept 8h
  staleAt(t);
  assert.equal((await inv().check()).ok, true, 'first check after wake → grace');
  // The health monitor keeps checking every 60s while awake.
  for (let i = 1; i <= 9; i++) {
    t += 60_000;
    assert.equal((await inv().check()).ok, true, `${i} min after wake → in the 10 min grace`);
  }
  t += 60_000;
  await inv().check(); // 10 min: grace boundary
  t += 60_000;
  assert.equal((await inv().check()).ok, false, '11 min after wake → judged again');
  closeDb(db);
});

test('isNetworkClassError: matches fetch-failed / unreachable shapes only', () => {
  for (const m of [
    'fetch failed',
    'transient upstream error: fetch failed',
    'getaddrinfo ENOTFOUND api.linear.app',
    'connect ENETUNREACH 1.2.3.4:443',
    'EAI_AGAIN',
  ]) {
    assert.equal(isNetworkClassError(m), true, m);
  }
  for (const m of ['secrets missing', 'invalid_grant', 'HTTP 401', undefined, null, '']) {
    assert.equal(isNetworkClassError(m), false, String(m));
  }
});

test('isUpstreamClassSkip: runtime-classified transient upstream skips + network shapes only', () => {
  for (const m of [
    'transient upstream error: whoop oauth refresh cooling off after a recent gateway failure (transient upstream)',
    'transient upstream error: open-meteo returned 503 (transient upstream)',
    'fetch failed',
  ]) {
    assert.equal(isUpstreamClassSkip(m), true, m);
  }
  for (const m of [
    'secrets missing',
    'oauth revoked: invalid_grant',
    'upstream said no',
    undefined,
    null,
    '',
  ]) {
    assert.equal(isUpstreamClassSkip(m), false, String(m));
  }
});

test('staleness: transient-upstream skip streak (whoop cool-off) moves to integrations.unreachable', async () => {
  const db = freshDb();
  setKv(db, 'whoop', 'last_attempt_at', isoAgo(60_000));
  setKv(db, 'whoop', 'last_ok_at', isoAgo(H));
  setKv(db, 'whoop', 'consecutive_skips', '4');
  setKv(
    db,
    'whoop',
    'last_skip_reason',
    'transient upstream error: whoop oauth refresh cooling off after a recent gateway failure (transient upstream)',
  );
  setKv(db, 'gmail', 'last_attempt_at', isoAgo(60_000));
  setKv(db, 'gmail', 'consecutive_skips', '3');
  setKv(db, 'gmail', 'last_skip_reason', 'oauth revoked: invalid_grant');
  const opts = {
    integrations: () => [
      { name: 'whoop', cron: '3-53/10 * * * *' },
      { name: 'gmail', cron: '*/15 * * * *' },
    ],
    policies: () => policies(),
    now,
    startedAt: () => null,
  };
  const stale = await integrationStalenessInvariant(db, opts).check();
  assert.equal(stale.ok, false, 'auth-class skip streak still flags staleness');
  assert.match(stale.message ?? '', /gmail: skipping/);
  assert.doesNotMatch(
    stale.message ?? '',
    /whoop/,
    'cool-off must not reach the repairable invariant',
  );

  const r = await integrationUnreachableInvariant(db, opts).check();
  assert.equal(r.ok, false);
  assert.match(
    r.message ?? '',
    /whoop: skipping \(transient upstream error: whoop oauth refresh cooling off/,
  );
  assert.doesNotMatch(r.message ?? '', /gmail/);
  closeDb(db);
});

test('staleness: network-class skip streak moves to integrations.unreachable (no repair → never escalates)', async () => {
  const db = freshDb();
  setKv(db, 'google_calendar', 'last_attempt_at', isoAgo(60_000));
  setKv(db, 'google_calendar', 'last_ok_at', isoAgo(4 * H));
  setKv(db, 'google_calendar', 'consecutive_skips', '5');
  setKv(db, 'google_calendar', 'last_skip_reason', 'fetch failed');
  setKv(db, 'gmail', 'last_attempt_at', isoAgo(60_000));
  setKv(db, 'gmail', 'consecutive_skips', '3');
  setKv(db, 'gmail', 'last_skip_reason', 'secrets missing');
  const integrations = [
    { name: 'google_calendar', cron: '*/15 * * * *' },
    { name: 'gmail', cron: '*/15 * * * *' },
  ];
  const opts = {
    integrations: () => integrations,
    policies: () => policies(),
    now,
    startedAt: () => null,
  };
  const stale = await integrationStalenessInvariant(db, opts).check();
  assert.equal(stale.ok, false);
  assert.match(stale.message ?? '', /gmail: skipping \(secrets missing\)/);
  assert.doesNotMatch(stale.message ?? '', /google_calendar/);

  const unreachable = integrationUnreachableInvariant(db, opts);
  assert.equal(unreachable.repair, undefined, 'no repair → the incident ladder never escalates it');
  assert.equal(unreachable.severity, 'warning');
  const r = await unreachable.check();
  assert.equal(r.ok, false);
  assert.match(r.message ?? '', /google_calendar: skipping \(fetch failed\)/);
  assert.doesNotMatch(r.message ?? '', /gmail/);
  closeDb(db);
});

test('staleness: age-stale with a network-class errored tick is unreachable, not stale', async () => {
  const db = freshDb();
  setKv(db, 'whoop', 'last_attempt_at', isoAgo(60_000));
  setKv(db, 'whoop', 'last_ok_at', isoAgo(13 * H));
  setKv(db, 'whoop', 'consecutive_errors', '4');
  db.prepare(
    `INSERT INTO jobs (name, trigger_kind, scheduled_at, state, last_error)
     VALUES ('integration.whoop.tick', 'cron', '2026-06-10T11:00:00Z', 'errored', 'TypeError: fetch failed')`,
  ).run();
  const opts = {
    integrations: () => [FOUR_HOURLY],
    policies: () => policies(),
    now,
    startedAt: () => null,
  };
  assert.equal((await integrationStalenessInvariant(db, opts).check()).ok, true);
  const r = await integrationUnreachableInvariant(db, opts).check();
  assert.equal(r.ok, false);
  assert.match(r.message ?? '', /whoop: stale 13h \(network unreachable\)/);
  closeDb(db);
});
