import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { closeDb, openDb } from '../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../brain/memory/migrations/index.ts';
import { enqueueJob } from '../../kernel/scheduler/claim.ts';
import { dbFilePath } from '../../lib/paths.ts';

test('foundation smoke: init → doctor → daemon → claim a queued job → stop cleanly', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'robin-smoke-'));
  // Isolate the user-data dir, the config dir, AND the home dir. `init` writes the
  // instance pointer (<configDir>/user-data-dir) via writeUserDataPointer; without
  // overriding XDG_CONFIG_HOME it clobbers the developer's real ~/.config/robin/user-data-dir
  // with this throwaway temp path, which then dangles once the temp dir is cleaned. `init`
  // ALSO registers MCP servers in ~/.claude.json (upsertUserScopeMcp) and installs Claude
  // hooks — both keyed off homedir() — so without overriding HOME it replaces the developer's
  // real robin/robin-extension MCP entries with ones pointing at this smoke dir, silently
  // breaking Robin MCP in every Claude session. Same class of leak that `--no-launchd`
  // prevents below.
  const home = join(userData, 'home');
  mkdirSync(home);
  const env = {
    ...process.env,
    ROBIN_USER_DATA_DIR: userData,
    XDG_CONFIG_HOME: join(userData, 'xdg-config'),
    HOME: home,
  };

  // 1. robin init --yes (invoke tsx directly to respect env).
  // `--no-launchd` is critical for tests: production `init` installs a real
  // launchd agent into the user's ~/Library/LaunchAgents pointing at this tmp
  // dir, which would leak past the test and KeepAlive-restart forever.
  const initOut = execFileSync(
    'tsx',
    ['system/surfaces/cli/index.ts', 'init', '--yes', '--no-launchd'],
    { env, encoding: 'utf8' },
  );
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

  // Poll for the job to complete instead of a fixed sleep — a fixed 3s window
  // flakes under a loaded parallel suite run (and overstays on a fast one).
  const deadline = Date.now() + 12_000;
  for (;;) {
    await sleep(250);
    const dbp = openDb(dbFilePath(userData));
    const r = dbp.prepare("SELECT state FROM jobs WHERE name = 'test.noop'").get() as
      | { state: string }
      | undefined;
    closeDb(dbp);
    if (r?.state === 'completed' || Date.now() > deadline) break;
  }
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
