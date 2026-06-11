import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeDb, openDb, type RobinDb } from '../../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../../brain/memory/migrations/index.ts';
import { type Policies, policiesSchema } from '../../config/schema.ts';
import {
  integrationStalenessInvariant,
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
