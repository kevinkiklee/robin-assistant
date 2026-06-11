import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeDb, openDb } from '../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../brain/memory/migrations/index.ts';
import { listOnDiskIntegrationNames } from './loader.ts';
import {
  gcOrphanIntegrationTicks,
  gcRemovedIntegrationState,
  registerIntegrations,
} from './scheduler-glue.ts';

function seedState(db: ReturnType<typeof freshDb>, integration: string, key: string, value = 'x') {
  db.prepare(
    `INSERT INTO integration_state (integration_name, key, value, updated_at)
     VALUES (?, ?, ?, '2026-01-01T00:00:00.000Z')`,
  ).run(integration, key, value);
}

function stateNames(db: ReturnType<typeof freshDb>): string[] {
  return (
    db.prepare('SELECT DISTINCT integration_name AS name FROM integration_state').all() as Array<{
      name: string;
    }>
  )
    .map((r) => r.name)
    .sort();
}

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'robin-glue-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

function makeIntegration(rootDir: string, name: string, schedule = '*/5 * * * *') {
  const dir = join(rootDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'integration.yaml'),
    `name: ${name}\nversion: 1.0.0\nschedule: "${schedule}"\n`,
  );
  writeFileSync(
    join(dir, 'index.js'),
    `export const integration = { tick: async () => ({ status: 'ok' }) };\n`,
  );
}

test('scheduler-glue: gcOrphanIntegrationTicks drops removed-integration ticks, keeps live + cognition jobs', () => {
  const db = freshDb();
  const ins = db.prepare(
    "INSERT INTO jobs (name, trigger_kind, scheduled_at, state) VALUES (?, 'cron', ?, 'pending')",
  );
  ins.run('integration.live.tick', '2026-01-01T00:00:00.000Z'); // a loaded integration
  ins.run('integration.github.tick', '2026-01-01T00:00:00.000Z'); // removed integration → orphan
  ins.run('dream.run', '2026-01-01T00:00:00.000Z'); // cognition job — must NOT be GC'd

  const removed = gcOrphanIntegrationTicks(db, new Set(['integration.live.tick']));
  assert.equal(removed, 1, 'only the orphaned github tick is deleted');

  const names = (
    db.prepare("SELECT name FROM jobs WHERE state='pending'").all() as Array<{ name: string }>
  )
    .map((r) => r.name)
    .sort();
  assert.deepEqual(
    names,
    ['dream.run', 'integration.live.tick'],
    'orphan tick gone; live integration tick + cognition job untouched',
  );
  closeDb(db);
});

test('scheduler-glue: gcRemovedIntegrationState drops removed-integration state, keeps on-disk', () => {
  const db = freshDb();
  seedState(db, 'github', 'last_attempt_at', '2026-05-24T19:00:00.000Z'); // removed → phantom
  seedState(db, 'github', 'last_ingest_at', '2026-05-24T15:36:00.000Z');
  seedState(db, 'whoop', 'access_token', 'secret-token'); // present on disk → must survive
  seedState(db, 'whoop', 'consecutive_errors', '0');

  // whoop is on disk; github is not.
  const removed = gcRemovedIntegrationState(db, new Set(['whoop', 'linear']));
  assert.equal(removed, 2, 'both github rows deleted');
  assert.deepEqual(stateNames(db), ['whoop'], 'github gone; whoop (incl. its token) preserved');
  closeDb(db);
});

test('scheduler-glue: gcRemovedIntegrationState is a no-op when the on-disk set is empty', () => {
  const db = freshDb();
  seedState(db, 'whoop', 'access_token', 'secret-token');
  // Empty set means we could not read the roots — must NOT nuke live credentials.
  const removed = gcRemovedIntegrationState(db, new Set());
  assert.equal(removed, 0, 'empty on-disk set → delete nothing');
  assert.deepEqual(stateNames(db), ['whoop']);
  closeDb(db);
});

test('scheduler-glue: registerIntegrations GCs the state of a removed integration', async () => {
  const db = freshDb();
  const sysRoot = mkdtempSync(join(tmpdir(), 'robin-glue-gcstate-sys-'));
  const userRoot = mkdtempSync(join(tmpdir(), 'robin-glue-gcstate-user-'));
  makeIntegration(userRoot, 'demo-live');
  // A tombstone from a deleted integration: KV rows but no directory anywhere.
  seedState(db, 'github', 'last_attempt_at', '2026-05-24T19:00:00.000Z');
  seedState(db, 'demo-live', 'last_attempt_at', '2026-05-29T00:00:00.000Z');

  const fakeDaemon = { registerHandler: () => {} } as unknown as Parameters<
    typeof registerIntegrations
  >[0];
  await registerIntegrations(fakeDaemon, db, () => null, {
    systemRoot: sysRoot,
    userDataRoot: userRoot,
  });

  assert.deepEqual(stateNames(db), ['demo-live'], 'github tombstone GCd; live integration kept');
  closeDb(db);
});

test('loader: listOnDiskIntegrationNames counts a present-but-broken dir (manifest only)', () => {
  const root = mkdtempSync(join(tmpdir(), 'robin-ondisk-'));
  // Valid manifest, but index.js would fail to import — still counts as present.
  const dir = join(root, 'flaky');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'integration.yaml'), 'name: flaky\nversion: 1.0.0\nschedule: manual\n');
  writeFileSync(join(dir, 'index.js'), 'throw new Error("boom at import");\n');
  const names = listOnDiskIntegrationNames([root]);
  assert.ok(names.has('flaky'), 'broken-but-present integration is on-disk (tokens safe)');
});

test('scheduler-glue: registers integrations and seeds cron jobs', async () => {
  const db = freshDb();
  const sysRoot = mkdtempSync(join(tmpdir(), 'robin-glue-sys-'));
  const userRoot = mkdtempSync(join(tmpdir(), 'robin-glue-user-'));
  makeIntegration(sysRoot, 'demo-a');
  makeIntegration(userRoot, 'demo-b');

  const registered: string[] = [];
  const fakeDaemon = {
    registerHandler: (name: string) => {
      registered.push(name);
    },
  } as unknown as Parameters<typeof registerIntegrations>[0];

  const r = await registerIntegrations(fakeDaemon, db, () => null, {
    systemRoot: sysRoot,
    userDataRoot: userRoot,
  });
  assert.equal(r.registered, 2);
  assert.equal(r.scheduled, 2);
  assert.ok(registered.includes('integration.demo-a.tick'));
  assert.ok(registered.includes('integration.demo-b.tick'));

  const rows = db.prepare("SELECT name FROM jobs WHERE state='pending'").all() as Array<{
    name: string;
  }>;
  const names = rows.map((r) => r.name);
  assert.ok(names.includes('integration.demo-a.tick'));
  closeDb(db);
});

test('scheduler-glue: skips event: schedules', async () => {
  const db = freshDb();
  const sysRoot = mkdtempSync(join(tmpdir(), 'robin-glue-sys-'));
  const userRoot = mkdtempSync(join(tmpdir(), 'robin-glue-user-'));
  makeIntegration(sysRoot, 'event-only', 'event:session_end');

  const fakeDaemon = { registerHandler: () => {} } as unknown as Parameters<
    typeof registerIntegrations
  >[0];
  const r = await registerIntegrations(fakeDaemon, db, () => null, {
    systemRoot: sysRoot,
    userDataRoot: userRoot,
  });
  assert.equal(r.registered, 1);
  assert.equal(r.scheduled, 0);
  closeDb(db);
});

test('scheduler-glue: runs integration.init on registration and cleanup on teardown', async () => {
  const db = freshDb();
  const sysRoot = mkdtempSync(join(tmpdir(), 'robin-glue-init-sys-'));
  const userRoot = mkdtempSync(join(tmpdir(), 'robin-glue-init-user-'));
  const dir = join(userRoot, 'gateway-demo');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'integration.yaml'),
    'name: gateway-demo\nversion: 1.0.0\nschedule: manual\n',
  );
  writeFileSync(
    join(dir, 'index.js'),
    `
    let initCalls = 0;
    let cleanupCalls = 0;
    export const integration = {
      init: async () => { initCalls++; globalThis.__gwInit = initCalls; },
      cleanup: async () => { cleanupCalls++; globalThis.__gwCleanup = cleanupCalls; },
    };
    `,
  );

  const fakeDaemon = { registerHandler: () => {} } as unknown as Parameters<
    typeof registerIntegrations
  >[0];
  const r = await registerIntegrations(fakeDaemon, db, () => null, {
    systemRoot: sysRoot,
    userDataRoot: userRoot,
  });
  assert.equal(r.registered, 1);
  assert.equal(r.initialized, 1);
  assert.equal((globalThis as unknown as { __gwInit: number }).__gwInit, 1);

  await r.cleanup();
  assert.equal((globalThis as unknown as { __gwCleanup: number }).__gwCleanup, 1);
  closeDb(db);
});

test('scheduler-glue: integration.init failure does not block other integrations', async () => {
  const db = freshDb();
  const sysRoot = mkdtempSync(join(tmpdir(), 'robin-glue-initfail-sys-'));
  const userRoot = mkdtempSync(join(tmpdir(), 'robin-glue-initfail-user-'));
  const failDir = join(userRoot, 'broken');
  mkdirSync(failDir, { recursive: true });
  writeFileSync(
    join(failDir, 'integration.yaml'),
    'name: broken\nversion: 1.0.0\nschedule: manual\n',
  );
  writeFileSync(
    join(failDir, 'index.js'),
    `export const integration = { init: async () => { throw new Error('boom'); } };\n`,
  );
  makeIntegration(userRoot, 'healthy');

  const fakeDaemon = { registerHandler: () => {} } as unknown as Parameters<
    typeof registerIntegrations
  >[0];
  const r = await registerIntegrations(fakeDaemon, db, () => null, {
    systemRoot: sysRoot,
    userDataRoot: userRoot,
  });
  assert.equal(r.registered, 2);
  assert.equal(r.initialized, 0); // broken's init threw; healthy has no init
  closeDb(db);
});

test('scheduler-glue: heartbeat writes last_ok_at on ok ticks only', async () => {
  const db = freshDb();
  const sysRoot = mkdtempSync(join(tmpdir(), 'robin-glue-okat-sys-'));
  const userRoot = mkdtempSync(join(tmpdir(), 'robin-glue-okat-user-'));

  // Integration that returns a controlled result via a mutable ref
  const dir = join(userRoot, 'ok-probe');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'integration.yaml'),
    'name: ok-probe\nversion: 1.0.0\nschedule: manual\n',
  );
  writeFileSync(
    join(dir, 'index.js'),
    `export const integration = { tick: async () => globalThis.__okProbeResult };\n`,
  );

  const handlers: Record<string, () => Promise<void>> = {};
  const fakeDaemon = {
    registerHandler: (name: string, handler: () => Promise<void>) => {
      handlers[name] = handler;
    },
  } as unknown as Parameters<typeof registerIntegrations>[0];

  await registerIntegrations(fakeDaemon, db, () => null, {
    systemRoot: sysRoot,
    userDataRoot: userRoot,
  });

  const tickHandler = handlers['integration.ok-probe.tick'];
  assert.ok(tickHandler, 'tick handler registered');

  const getState = (key: string) =>
    (
      db
        .prepare(
          `SELECT value FROM integration_state WHERE integration_name = 'ok-probe' AND key = ?`,
        )
        .get(key) as { value: string } | undefined
    )?.value;

  // --- ok tick: last_ok_at must be written ---
  (globalThis as unknown as Record<string, unknown>).__okProbeResult = {
    status: 'ok',
    ingested: 0,
  };
  await tickHandler();
  const okAt = getState('last_ok_at');
  assert.ok(okAt, 'last_ok_at written after ok tick');
  assert.ok(!Number.isNaN(Date.parse(okAt)), 'last_ok_at is a valid ISO timestamp');

  // --- error tick: last_ok_at must NOT change ---
  (globalThis as unknown as Record<string, unknown>).__okProbeResult = {
    status: 'error',
    message: 'boom',
  };
  await tickHandler();
  assert.equal(getState('last_ok_at'), okAt, 'last_ok_at unchanged after error tick');

  // --- skip tick: last_ok_at must NOT change ---
  (globalThis as unknown as Record<string, unknown>).__okProbeResult = {
    status: 'skipped',
    message: 'no creds',
  };
  await tickHandler();
  assert.equal(getState('last_ok_at'), okAt, 'last_ok_at unchanged after skip tick');

  closeDb(db);
});

test('scheduler-glue: consecutive_skips increments on skip, resets on ok, unchanged on error', async () => {
  const db = freshDb();
  const sysRoot = mkdtempSync(join(tmpdir(), 'robin-glue-skips-sys-'));
  const userRoot = mkdtempSync(join(tmpdir(), 'robin-glue-skips-user-'));

  const dir = join(userRoot, 'skip-probe');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'integration.yaml'),
    'name: skip-probe\nversion: 1.0.0\nschedule: manual\n',
  );
  writeFileSync(
    join(dir, 'index.js'),
    `export const integration = { tick: async () => globalThis.__skipProbeResult };\n`,
  );

  const handlers: Record<string, () => Promise<void>> = {};
  const fakeDaemon = {
    registerHandler: (name: string, handler: () => Promise<void>) => {
      handlers[name] = handler;
    },
  } as unknown as Parameters<typeof registerIntegrations>[0];

  await registerIntegrations(fakeDaemon, db, () => null, {
    systemRoot: sysRoot,
    userDataRoot: userRoot,
  });

  const tickHandler = handlers['integration.skip-probe.tick'];
  assert.ok(tickHandler, 'tick handler registered');

  const getState = (key: string) =>
    (
      db
        .prepare(
          `SELECT value FROM integration_state WHERE integration_name = 'skip-probe' AND key = ?`,
        )
        .get(key) as { value: string } | undefined
    )?.value;

  const setResult = (r: unknown) => {
    (globalThis as unknown as Record<string, unknown>).__skipProbeResult = r;
  };

  // --- first skip: consecutive_skips → '1' ---
  setResult({ status: 'skipped', message: 'no creds' });
  await tickHandler();
  assert.equal(getState('consecutive_skips'), '1', 'first skip → 1');

  // --- second skip: consecutive_skips → '2' ---
  setResult({ status: 'skipped', message: 'no creds' });
  await tickHandler();
  assert.equal(getState('consecutive_skips'), '2', 'second skip → 2');

  // --- error tick: consecutive_skips unchanged ---
  setResult({ status: 'error', message: 'boom' });
  await tickHandler();
  assert.equal(getState('consecutive_skips'), '2', 'error leaves skip streak unchanged');

  // --- ok tick: consecutive_skips reset to '0' ---
  setResult({ status: 'ok', ingested: 0 });
  await tickHandler();
  assert.equal(getState('consecutive_skips'), '0', 'clean ok resets skip streak');

  closeDb(db);
});

test('scheduler-glue: degraded tick increments degraded:stream counters but still writes last_ok_at', async () => {
  const db = freshDb();
  const sysRoot = mkdtempSync(join(tmpdir(), 'robin-glue-degraded-sys-'));
  const userRoot = mkdtempSync(join(tmpdir(), 'robin-glue-degraded-user-'));

  const dir = join(userRoot, 'deg-probe');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'integration.yaml'),
    'name: deg-probe\nversion: 1.0.0\nschedule: manual\n',
  );
  writeFileSync(
    join(dir, 'index.js'),
    `export const integration = { tick: async () => globalThis.__degProbeResult };\n`,
  );

  const handlers: Record<string, () => Promise<void>> = {};
  const fakeDaemon = {
    registerHandler: (name: string, handler: () => Promise<void>) => {
      handlers[name] = handler;
    },
  } as unknown as Parameters<typeof registerIntegrations>[0];

  await registerIntegrations(fakeDaemon, db, () => null, {
    systemRoot: sysRoot,
    userDataRoot: userRoot,
  });

  const tickHandler = handlers['integration.deg-probe.tick'];
  assert.ok(tickHandler, 'tick handler registered');

  const getKv = (key: string) =>
    (
      db
        .prepare(
          `SELECT value FROM integration_state WHERE integration_name = 'deg-probe' AND key = ?`,
        )
        .get(key) as { value: string } | undefined
    )?.value;

  const setResult = (r: unknown) => {
    (globalThis as unknown as Record<string, unknown>).__degProbeResult = r;
  };

  // --- first degraded tick: degraded:recovery → '1', last_ok_at is written ---
  setResult({ status: 'ok', ingested: 2, degraded: ['recovery'] });
  await tickHandler();
  assert.equal(getKv('degraded:recovery'), '1', 'first degraded tick → count 1');
  const firstOkAt = getKv('last_ok_at');
  assert.ok(firstOkAt, 'degraded tick still writes last_ok_at');

  // --- second degraded tick: degraded:recovery → '2' ---
  setResult({ status: 'ok', ingested: 2, degraded: ['recovery'] });
  await tickHandler();
  assert.equal(getKv('degraded:recovery'), '2', 'second degraded tick → count 2');

  // --- clean ok tick: all degraded:* keys reset to '0' ---
  setResult({ status: 'ok', ingested: 5 });
  await tickHandler();
  assert.equal(getKv('degraded:recovery'), '0', 'clean ok tick resets degraded:recovery to 0');
  const afterCleanOkAt = getKv('last_ok_at');
  assert.ok(afterCleanOkAt, 'clean ok tick writes last_ok_at too');

  closeDb(db);
});

test('scheduler-glue: degraded tick with multiple failed streams increments each independently', async () => {
  const db = freshDb();
  const sysRoot = mkdtempSync(join(tmpdir(), 'robin-glue-degraded2-sys-'));
  const userRoot = mkdtempSync(join(tmpdir(), 'robin-glue-degraded2-user-'));

  const dir = join(userRoot, 'deg-multi');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'integration.yaml'),
    'name: deg-multi\nversion: 1.0.0\nschedule: manual\n',
  );
  writeFileSync(
    join(dir, 'index.js'),
    `export const integration = { tick: async () => globalThis.__degMultiResult };\n`,
  );

  const handlers: Record<string, () => Promise<void>> = {};
  const fakeDaemon = {
    registerHandler: (name: string, handler: () => Promise<void>) => {
      handlers[name] = handler;
    },
  } as unknown as Parameters<typeof registerIntegrations>[0];

  await registerIntegrations(fakeDaemon, db, () => null, {
    systemRoot: sysRoot,
    userDataRoot: userRoot,
  });

  const tickHandler = handlers['integration.deg-multi.tick'];
  assert.ok(tickHandler, 'tick handler registered');

  const getKv = (key: string) =>
    (
      db
        .prepare(
          `SELECT value FROM integration_state WHERE integration_name = 'deg-multi' AND key = ?`,
        )
        .get(key) as { value: string } | undefined
    )?.value;

  const setResult = (r: unknown) => {
    (globalThis as unknown as Record<string, unknown>).__degMultiResult = r;
  };

  // Two streams fail: both should get count 1
  setResult({ status: 'ok', ingested: 1, degraded: ['recovery', 'sleep'] });
  await handlers['integration.deg-multi.tick']();
  assert.equal(getKv('degraded:recovery'), '1');
  assert.equal(getKv('degraded:sleep'), '1');

  // Only recovery fails next time: recovery → 2, sleep resets to 0
  setResult({ status: 'ok', ingested: 1, degraded: ['recovery'] });
  await tickHandler();
  assert.equal(getKv('degraded:recovery'), '2', 'recovery increments to 2');
  assert.equal(getKv('degraded:sleep'), '0', 'sleep resets to 0 when absent from degraded');

  closeDb(db);
});

test('scheduler-glue: degraded counter is frozen (not reset, not incremented) on a skip tick', async () => {
  const db = freshDb();
  const sysRoot = mkdtempSync(join(tmpdir(), 'robin-glue-degfreeze-sys-'));
  const userRoot = mkdtempSync(join(tmpdir(), 'robin-glue-degfreeze-user-'));

  const dir = join(userRoot, 'deg-freeze');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'integration.yaml'),
    'name: deg-freeze\nversion: 1.0.0\nschedule: manual\n',
  );
  writeFileSync(
    join(dir, 'index.js'),
    `export const integration = { tick: async () => globalThis.__degFreezeResult };\n`,
  );

  const handlers: Record<string, () => Promise<void>> = {};
  const fakeDaemon = {
    registerHandler: (name: string, handler: () => Promise<void>) => {
      handlers[name] = handler;
    },
  } as unknown as Parameters<typeof registerIntegrations>[0];

  await registerIntegrations(fakeDaemon, db, () => null, {
    systemRoot: sysRoot,
    userDataRoot: userRoot,
  });

  const tickHandler = handlers['integration.deg-freeze.tick'];
  assert.ok(tickHandler, 'tick handler registered');

  const getKv = (key: string) =>
    (
      db
        .prepare(
          `SELECT value FROM integration_state WHERE integration_name = 'deg-freeze' AND key = ?`,
        )
        .get(key) as { value: string } | undefined
    )?.value;

  const setResult = (r: unknown) => {
    (globalThis as unknown as Record<string, unknown>).__degFreezeResult = r;
  };

  // --- degraded ok tick: counter → '1' ---
  setResult({ status: 'ok', ingested: 1, degraded: ['recovery'] });
  await tickHandler();
  assert.equal(getKv('degraded:recovery'), '1', 'degraded ok tick → counter 1');

  // --- skip tick: degraded counter must remain '1' (frozen, not reset, not incremented) ---
  setResult({ status: 'skipped', message: 'auth revoked' });
  await tickHandler();
  assert.equal(getKv('degraded:recovery'), '1', 'skip tick leaves degraded:recovery frozen at 1');

  closeDb(db);
});

test('scheduler-glue: multi-instance integrations get distinct handler + cron names', async () => {
  const db = freshDb();
  const sysRoot = mkdtempSync(join(tmpdir(), 'robin-multi-glue-sys-'));
  const userRoot = mkdtempSync(join(tmpdir(), 'robin-multi-glue-user-'));
  // Create two instances of the same base integration name
  makeIntegration(userRoot, 'demo--alpha', '*/5 * * * *');
  makeIntegration(userRoot, 'demo--beta', '*/5 * * * *');
  const registered: string[] = [];
  const fakeDaemon = {
    registerHandler: (name: string) => {
      registered.push(name);
    },
  } as unknown as Parameters<typeof registerIntegrations>[0];
  const r = await registerIntegrations(fakeDaemon, db, () => null, {
    systemRoot: sysRoot,
    userDataRoot: userRoot,
  });
  assert.equal(r.registered, 2);
  assert.ok(registered.includes('integration.demo--alpha.tick'));
  assert.ok(registered.includes('integration.demo--beta.tick'));
  const jobs = db.prepare("SELECT name FROM jobs WHERE state='pending'").all() as Array<{
    name: string;
  }>;
  const jobNames = jobs.map((j) => j.name);
  assert.ok(jobNames.includes('integration.demo--alpha.tick'));
  assert.ok(jobNames.includes('integration.demo--beta.tick'));
  closeDb(db);
});
