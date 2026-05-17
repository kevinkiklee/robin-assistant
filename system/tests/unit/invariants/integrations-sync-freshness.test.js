// Quiet-window awareness: integrations whose next_run_at is still in the
// future (e.g. finance_quote outside NYSE hours, whoop deferred until
// secrets are present) must not be flagged stale. This guards the
// 2026-05-16 regression where the freshness invariant flagged finance_quote
// every night because its quiet_window skips ~17 hours/day.

import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { writeConfig } from '../../../config/paths.js';
import { close, connect } from '../../../data/db/client.js';
import { runMigrations } from '../../../data/db/migrate.js';
import integrationsSyncFreshness from '../../../runtime/invariants/integrations.sync-freshness.js';
import { makeTestCtx } from '../../helpers/invariant-fixtures.js';

const tmpRoot = join(
  tmpdir(),
  `robin-sync-fresh-${process.pid}-${Math.random().toString(36).slice(2)}`,
);
mkdirSync(tmpRoot, { recursive: true });
process.env.ROBIN_HOME = tmpRoot;
await writeConfig({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, join(import.meta.dirname, '../../../data/db/migrations'));
  return db;
}

async function seedScheduler(db, integrations) {
  await db
    .query('UPSERT runtime:scheduler CONTENT { value: $value }', { value: { integrations } })
    .collect();
}

test('flags an integration whose last_sync_at exceeds 2x cadence and next_run_at is past-due', async () => {
  const db = await fresh();
  try {
    const now = Date.now();
    const fourHoursAgo = new Date(now - 4 * 3600_000).toISOString();
    const oneMinuteAgo = new Date(now - 60_000).toISOString();
    await seedScheduler(db, {
      stale_int: {
        enabled: true,
        cadence_ms: 60 * 60_000, // 1h cadence; 2x = 2h
        last_sync_at: fourHoursAgo,
        next_run_at: oneMinuteAgo, // past-due — should have fired
      },
    });
    const r = await integrationsSyncFreshness.check(makeTestCtx({ db }));
    assert.equal(r.ok, false);
    assert.equal(r.error, 'integrations_stale');
    assert.equal(r.evidence.stale_integrations[0].name, 'stale_int');
  } finally {
    await close(db);
  }
});

test('does NOT flag an integration whose next_run_at is in the future (quiet_window)', async () => {
  const db = await fresh();
  try {
    const now = Date.now();
    const eightHoursAgo = new Date(now - 8 * 3600_000).toISOString();
    const sixHoursFromNow = new Date(now + 6 * 3600_000).toISOString();
    // Mimics finance_quote outside NYSE hours: last sync 8h ago,
    // next fire scheduled 6h from now (waiting for market open).
    await seedScheduler(db, {
      finance_quote: {
        enabled: true,
        cadence_ms: 30 * 60_000, // 30m cadence; 2x = 1h
        last_sync_at: eightHoursAgo,
        next_run_at: sixHoursFromNow,
      },
    });
    const r = await integrationsSyncFreshness.check(makeTestCtx({ db }));
    assert.equal(r.ok, true, `expected ok, got error=${r.error}`);
    assert.equal(r.evidence.enabled_count, 1);
  } finally {
    await close(db);
  }
});

test('does NOT flag an integration synced within the threshold', async () => {
  const db = await fresh();
  try {
    const now = Date.now();
    const tenMinutesAgo = new Date(now - 10 * 60_000).toISOString();
    await seedScheduler(db, {
      fresh_int: {
        enabled: true,
        cadence_ms: 60 * 60_000, // 1h cadence; 2x = 2h
        last_sync_at: tenMinutesAgo,
      },
    });
    const r = await integrationsSyncFreshness.check(makeTestCtx({ db }));
    assert.equal(r.ok, true);
  } finally {
    await close(db);
  }
});

test('skips disabled integrations from the staleness check', async () => {
  const db = await fresh();
  try {
    const fourHoursAgo = new Date(Date.now() - 4 * 3600_000).toISOString();
    await seedScheduler(db, {
      ancient: {
        enabled: false,
        cadence_ms: 60 * 60_000,
        last_sync_at: fourHoursAgo,
      },
    });
    const r = await integrationsSyncFreshness.check(makeTestCtx({ db }));
    assert.equal(r.ok, true);
    assert.equal(r.evidence.enabled_count, 0);
  } finally {
    await close(db);
  }
});
