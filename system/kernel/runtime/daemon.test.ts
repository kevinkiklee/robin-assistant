import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { closeDb, openDb } from '../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../brain/memory/migrations/index.ts';
import { dbFilePath, pidFilePath } from '../../lib/paths.ts';
import { enqueueJob } from '../scheduler/claim.ts';
import { Daemon } from './daemon.ts';

function freshUserData(): string {
  const dir = mkdtempSync(join(tmpdir(), 'robin-daemon-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  mkdirSync(join(dir, 'state', 'runtime'), { recursive: true });
  mkdirSync(join(dir, 'observability', 'logs'), { recursive: true });
  mkdirSync(join(dir, 'config'), { recursive: true });
  return dir;
}

test('daemon: start writes pidfile, stop removes it', async () => {
  const userData = freshUserData();
  process.env.ROBIN_USER_DATA_DIR = userData;

  const daemon = new Daemon();
  daemon.registerHandler('test.noop', async () => {});
  const startPromise = daemon.start({ foreground: true });

  // Let it tick once
  await sleep(100);

  assert.ok(existsSync(pidFilePath(userData)), 'pidfile should exist while daemon runs');
  await daemon.stop('test');
  await startPromise.catch(() => {});
  assert.ok(!existsSync(pidFilePath(userData)), 'pidfile should be removed after stop');
});

test('daemon: claims and runs a queued no-op job', async () => {
  const userData = freshUserData();
  process.env.ROBIN_USER_DATA_DIR = userData;

  // Pre-seed a manual job
  const db = openDb(dbFilePath(userData));
  applyMigrations(db, allMigrations);
  enqueueJob(db, {
    name: 'test.noop',
    trigger_kind: 'manual',
    scheduled_at: new Date().toISOString(),
  });
  closeDb(db);

  let calls = 0;
  const daemon = new Daemon();
  daemon.registerHandler('test.noop', async () => {
    calls++;
  });

  const startPromise = daemon.start({ foreground: true });
  await sleep(1500); // tick interval is 1s
  await daemon.stop('test');
  await startPromise.catch(() => {});

  assert.ok(calls >= 1, `expected handler to be called at least once, got ${calls}`);
});
