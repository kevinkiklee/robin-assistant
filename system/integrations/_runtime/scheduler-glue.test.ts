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
