import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeDb, openDb } from '../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../brain/memory/migrations/index.ts';
import { registerIntegrations } from './scheduler-glue.ts';

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
