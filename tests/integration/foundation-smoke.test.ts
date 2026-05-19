import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { closeDb, openDb } from '../../system/brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../system/brain/memory/migrations/index.ts';
import { enqueueJob } from '../../system/kernel/scheduler/claim.ts';
import { dbFilePath } from '../../system/lib/paths.ts';

test('foundation smoke: init → doctor → daemon → claim a queued job → stop cleanly', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'robin-smoke-'));
  const env = { ...process.env, ROBIN_USER_DATA_DIR: userData };

  // 1. robin init --yes (invoke tsx directly to respect env)
  const initOut = execFileSync('tsx', ['system/surfaces/cli/index.ts', 'init', '--yes'], {
    env,
    encoding: 'utf8',
  });
  assert.ok(initOut.includes('Initialized Robin'), `init failed: ${initOut}`);
  assert.ok(
    existsSync(dbFilePath(userData)),
    `db should exist after init at ${dbFilePath(userData)}`,
  );

  // 2. robin doctor exits 0
  execFileSync('tsx', ['system/surfaces/cli/index.ts', 'doctor'], { env, encoding: 'utf8' });

  // 3. Pre-seed a job
  const db = openDb(dbFilePath(userData));
  applyMigrations(db, allMigrations);
  enqueueJob(db, {
    name: 'test.noop',
    trigger_kind: 'manual',
    scheduled_at: new Date().toISOString(),
  });
  closeDb(db);

  // 4. Start daemon in background, wait, kill
  const daemon = spawn('tsx', ['system/surfaces/cli/index.ts', 'daemon', '--foreground'], {
    env,
    stdio: 'pipe',
  });
  let output = '';
  daemon.stdout?.on('data', (d) => {
    output += d.toString();
  });
  daemon.stderr?.on('data', (d) => {
    output += d.toString();
  });

  await sleep(3000); // long enough for at least 2 ticks
  daemon.kill('SIGTERM');

  await new Promise<void>((resolve) => {
    daemon.on('exit', () => {
      resolve();
    });
  });

  // 5. Verify the job ran (state='completed' in the DB)
  const db2 = openDb(dbFilePath(userData));
  const row = db2.prepare("SELECT state FROM jobs WHERE name = 'test.noop'").get() as
    | { state: string }
    | undefined;
  closeDb(db2);
  assert.ok(row, 'no row for test.noop after daemon run');
  assert.equal(
    row.state,
    'completed',
    `expected completed, got ${row.state}. Daemon output: ${output}`,
  );
});
