// Tests for integrations.no_stuck_in_flight: detection + auto-repair of
// integration sync rows wedged with in_flight=true past max(2× cadence, 30 min).

import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { writeConfig } from '../../../config/paths.js';
import { close, connect } from '../../../data/db/client.js';
import { runMigrations } from '../../../data/db/migrate.js';
import integrationsNoStuckInFlight from '../../../runtime/invariants/integrations.no-stuck-in-flight.js';
import { makeTestCtx } from '../../helpers/invariant-fixtures.js';

const tmpRoot = join(
  tmpdir(),
  `robin-stuck-inv-${process.pid}-${Math.random().toString(36).slice(2)}`,
);
mkdirSync(tmpRoot, { recursive: true });
process.env.ROBIN_HOME = tmpRoot;
await writeConfig({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../../data/db/migrations'));
  return db;
}

async function seed(db, integrations) {
  const [rows] = await db
    .query(surql`SELECT * FROM type::record('runtime', 'scheduler')`)
    .collect();
  const value = rows[0]?.value ?? {};
  await db
    .query(
      surql`UPSERT type::record('runtime', 'scheduler') SET value = ${{ ...value, integrations }}`,
    )
    .collect();
}

async function readIntegrations(db) {
  const [rows] = await db
    .query(surql`SELECT * FROM type::record('runtime', 'scheduler')`)
    .collect();
  return rows[0]?.value?.integrations ?? {};
}

test('returns ok when no integration is in_flight', async () => {
  const db = await fresh();
  try {
    await seed(db, {
      gmail: { cadence_ms: 900_000, in_flight: false },
      whoop: { cadence_ms: 1_800_000, in_flight: false },
    });
    const r = await integrationsNoStuckInFlight.check(makeTestCtx({ db }));
    assert.equal(r.ok, true);
    assert.equal(r.evidence.count, 0);
  } finally {
    await close(db);
  }
});

test('returns ok when in_flight is fresh (under threshold)', async () => {
  const db = await fresh();
  try {
    await seed(db, {
      gmail: {
        cadence_ms: 900_000, // 15 min → threshold = max(30m, 30m) = 30m
        in_flight: true,
        in_flight_started_at: new Date(Date.now() - 5 * 60_000), // 5 min old
      },
    });
    const r = await integrationsNoStuckInFlight.check(makeTestCtx({ db }));
    assert.equal(r.ok, true);
  } finally {
    await close(db);
  }
});

test('flags an integration stuck past the cadence-based threshold', async () => {
  const db = await fresh();
  try {
    await seed(db, {
      github: {
        cadence_ms: 3_600_000, // 1h → threshold = 2h
        in_flight: true,
        in_flight_started_at: new Date(Date.now() - 3 * 60 * 60_000), // 3h old
      },
    });
    const r = await integrationsNoStuckInFlight.check(makeTestCtx({ db }));
    assert.equal(r.ok, false);
    assert.equal(r.error, 'stuck_integrations');
    assert.deepEqual(r.evidence.names, ['github']);
  } finally {
    await close(db);
  }
});

test('flags using 30-min floor when cadence is tiny', async () => {
  const db = await fresh();
  try {
    await seed(db, {
      finance_quote: {
        cadence_ms: 60_000, // 1m → 2× = 2m, floor = 30m wins
        in_flight: true,
        in_flight_started_at: new Date(Date.now() - 10 * 60_000), // 10m old, under 30m floor
      },
    });
    const r = await integrationsNoStuckInFlight.check(makeTestCtx({ db }));
    assert.equal(r.ok, true, '10m < 30m floor → not stuck');
  } finally {
    await close(db);
  }
});

test('repair clears in_flight, marks last_sync_error, resets next_run_at', async () => {
  const db = await fresh();
  try {
    await seed(db, {
      gmail: {
        cadence_ms: 900_000,
        in_flight: true,
        in_flight_started_at: new Date(Date.now() - 7 * 60 * 60_000),
        last_sync_error: null,
        next_run_at: new Date(Date.now() + 24 * 60 * 60_000), // far future (backoff)
      },
      whoop: {
        cadence_ms: 1_800_000,
        in_flight: false, // not stuck, should not be touched
      },
    });
    const outcome = await integrationsNoStuckInFlight.repair(makeTestCtx({ db }));
    assert.equal(outcome.repaired, true);
    assert.deepEqual(outcome.evidence.cleared, ['gmail']);
    const after = await readIntegrations(db);
    assert.equal(after.gmail.in_flight, false);
    assert.equal(after.gmail.in_flight_started_at, null);
    assert.match(after.gmail.last_sync_error, /watchdog-cleanup/);
    assert.ok(
      new Date(after.gmail.next_run_at).getTime() <= Date.now() + 1_000,
      'next_run_at reset to ~now so dispatcher picks up immediately',
    );
    // Whoop untouched
    assert.equal(after.whoop.in_flight, false);
    assert.equal(after.whoop.last_sync_error, undefined);
  } finally {
    await close(db);
  }
});

test('repair preserves prior last_sync_error message', async () => {
  const db = await fresh();
  try {
    await seed(db, {
      letterboxd: {
        cadence_ms: 3_600_000,
        in_flight: true,
        in_flight_started_at: new Date(Date.now() - 12 * 60 * 60_000),
        last_sync_error: 'fetch failed',
      },
    });
    await integrationsNoStuckInFlight.repair(makeTestCtx({ db }));
    const after = await readIntegrations(db);
    assert.match(after.letterboxd.last_sync_error, /^fetch failed \[watchdog-cleanup/);
  } finally {
    await close(db);
  }
});

test('repair is idempotent — second run does not double-append marker', async () => {
  const db = await fresh();
  try {
    await seed(db, {
      letterboxd: {
        cadence_ms: 3_600_000,
        in_flight: true,
        in_flight_started_at: new Date(Date.now() - 12 * 60 * 60_000),
        last_sync_error: 'fetch failed',
      },
    });
    await integrationsNoStuckInFlight.repair(makeTestCtx({ db }));
    // Re-mark stuck (as if a fresh hang occurred) and repair again
    await seed(db, {
      letterboxd: {
        ...(await readIntegrations(db)).letterboxd,
        in_flight: true,
        in_flight_started_at: new Date(Date.now() - 12 * 60 * 60_000),
      },
    });
    await integrationsNoStuckInFlight.repair(makeTestCtx({ db }));
    const after = await readIntegrations(db);
    const matches = after.letterboxd.last_sync_error.match(/watchdog-cleanup/g) ?? [];
    assert.equal(matches.length, 1, 'marker should appear at most once');
  } finally {
    await close(db);
  }
});

test('dryRun reports plan without writing', async () => {
  const db = await fresh();
  try {
    await seed(db, {
      gmail: {
        cadence_ms: 900_000,
        in_flight: true,
        in_flight_started_at: new Date(Date.now() - 7 * 60 * 60_000),
      },
    });
    const ctx = makeTestCtx({ db, dryRun: true });
    const outcome = await integrationsNoStuckInFlight.repair(ctx);
    assert.equal(outcome.repaired, false);
    assert.equal(outcome.action, 'would_clear_in_flight');
    assert.deepEqual(outcome.plan.targets, ['gmail']);
    // No writes
    const after = await readIntegrations(db);
    assert.equal(after.gmail.in_flight, true);
  } finally {
    await close(db);
  }
});

test('enabled() returns false when no integrations are registered', async () => {
  const db = await fresh();
  try {
    const r = await integrationsNoStuckInFlight.enabled(makeTestCtx({ db }));
    assert.equal(r, false);
  } finally {
    await close(db);
  }
});

test('enabled() returns true once any integration is registered', async () => {
  const db = await fresh();
  try {
    await seed(db, { gmail: { cadence_ms: 900_000 } });
    const r = await integrationsNoStuckInFlight.enabled(makeTestCtx({ db }));
    assert.equal(r, true);
  } finally {
    await close(db);
  }
});

test('check returns no_db_handle when ctx.db missing', async () => {
  const r = await integrationsNoStuckInFlight.check(makeTestCtx({ db: null }));
  assert.equal(r.ok, false);
  assert.equal(r.error, 'no_db_handle');
});
