import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeDb, openDb } from '../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../brain/memory/migrations/index.ts';
import { registerJobs } from './scheduler-glue.ts';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'robin-jobs-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

function makeJob(rootDir: string, name: string, schedule = '*/10 * * * *') {
  const dir = join(rootDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'job.yaml'), `name: ${name}\nversion: 1.0.0\nschedule: "${schedule}"\n`);
  writeFileSync(
    join(dir, 'index.js'),
    `export const job = { run: async () => ({ status: 'ok' }) };\n`,
  );
}

test('jobs scheduler-glue: registers handler + seeds cron schedule', async () => {
  const db = freshDb();
  const sysRoot = mkdtempSync(join(tmpdir(), 'robin-jobs-sys-'));
  const userRoot = mkdtempSync(join(tmpdir(), 'robin-jobs-user-'));
  makeJob(userRoot, 'demo-brief');
  const registered: string[] = [];
  const fakeDaemon = {
    registerHandler: (n: string) => {
      registered.push(n);
    },
  } as unknown as Parameters<typeof registerJobs>[0];
  const r = await registerJobs(fakeDaemon, db, () => null, {
    systemRoot: sysRoot,
    userDataRoot: userRoot,
  });
  assert.equal(r.registered, 1);
  assert.equal(r.scheduled, 1);
  assert.ok(registered.includes('job.demo-brief.run'));
  closeDb(db);
});

test('jobs scheduler-glue: manual jobs are registered but not scheduled', async () => {
  const db = freshDb();
  const sysRoot = mkdtempSync(join(tmpdir(), 'robin-jobs-sys-'));
  const userRoot = mkdtempSync(join(tmpdir(), 'robin-jobs-user-'));
  makeJob(userRoot, 'oneshot', 'manual');
  const fakeDaemon = { registerHandler: () => {} } as unknown as Parameters<typeof registerJobs>[0];
  const r = await registerJobs(fakeDaemon, db, () => null, {
    systemRoot: sysRoot,
    userDataRoot: userRoot,
  });
  assert.equal(r.registered, 1);
  assert.equal(r.scheduled, 0);
  closeDb(db);
});
