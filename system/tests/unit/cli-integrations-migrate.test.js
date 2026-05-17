import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { surql } from 'surrealdb';
import { writeConfig as __robinWriteConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { readIntegrationsState } from '../../data/runtime/integrations-state.js';
import { runMigrate } from '../../runtime/cli/commands/integrations-migrate.js';

const __robinTestHome = join(
  tmpdir(),
  `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
);
mkdirSync(__robinTestHome, { recursive: true });
process.env.ROBIN_HOME = __robinTestHome;
await __robinWriteConfig({ embedder_profile: 'mxbai-1024' });

async function freshDb() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  return db;
}

function makeFakeFS() {
  const sys = mkdtempSync(join(tmpdir(), 'robin-sys-'));
  const user = mkdtempSync(join(tmpdir(), 'robin-user-'));
  return { sys, user };
}

function seedManifest(dir, name, manifestCode = null) {
  mkdirSync(join(dir, name), { recursive: true });
  const body =
    manifestCode ??
    `export const manifest = { name: '${name}', cadence: '1h', sync: async () => {}, tools: [] };`;
  writeFileSync(join(dir, name, 'manifest.js'), body);
}

test('migrate is idempotent — second run is a no-op', async () => {
  const db = await freshDb();
  const { sys, user } = makeFakeFS();
  try {
    seedManifest(sys, 'spotify');
    const first = await runMigrate({ db, systemDir: sys, userDataDir: user, daemonRunning: false });
    assert.equal(first.exitCode, 0);
    const second = await runMigrate({
      db,
      systemDir: sys,
      userDataDir: user,
      daemonRunning: false,
    });
    assert.equal(second.exitCode, 0);
    assert.ok(/already migrated/.test(second.stdout));
  } finally {
    rmSync(sys, { recursive: true, force: true });
    rmSync(user, { recursive: true, force: true });
    await close(db);
  }
});

test('migrate refuses while daemon is running', async () => {
  const db = await freshDb();
  const { sys, user } = makeFakeFS();
  try {
    const out = await runMigrate({
      db,
      systemDir: sys,
      userDataDir: user,
      daemonRunning: true,
      daemonPid: 12345,
    });
    assert.equal(out.exitCode, 2);
    assert.ok(/daemon is running on pid 12345/.test(out.stderr));
  } finally {
    rmSync(sys, { recursive: true, force: true });
    rmSync(user, { recursive: true, force: true });
    await close(db);
  }
});

test('migrate moves non-system integrations and auto-enables active ones', async () => {
  const db = await freshDb();
  const { sys, user } = makeFakeFS();
  try {
    // Seed system with spotify + gmail; only spotify has a scheduler row (auto-enable candidate).
    seedManifest(sys, 'spotify');
    seedManifest(sys, 'gmail');
    await db
      .query(
        surql`UPSERT type::record('runtime', 'scheduler') SET value = ${{
          integrations: {
            spotify: { cadence_ms: 60_000, next_run_at: new Date(), consecutive_failures: 0 },
          },
        }}`,
      )
      .collect();

    const out = await runMigrate({ db, systemDir: sys, userDataDir: user, daemonRunning: false });
    assert.equal(out.exitCode, 0);

    // spotify moved; gmail stayed.
    assert.equal(existsSync(join(sys, 'spotify', 'manifest.js')), false);
    assert.equal(existsSync(join(user, 'spotify', 'manifest.js')), true);
    assert.equal(existsSync(join(sys, 'gmail', 'manifest.js')), true);

    // State: spotify enabled (scheduler row → active), gmail disabled (no scheduler row → not active).
    const state = await readIntegrationsState(db);
    assert.equal(state.states.spotify.enabled, true);
    assert.equal(state.states.spotify.source, 'user-data');
    assert.equal(state.states.gmail?.enabled, false);
    assert.equal(state.states.gmail?.source, 'system');
    assert.ok(state.migrated_at != null);
  } finally {
    rmSync(sys, { recursive: true, force: true });
    rmSync(user, { recursive: true, force: true });
    await close(db);
  }
});

test('migrate gateway fallback enables system-side gateways without scheduler.gateways', async () => {
  const db = await freshDb();
  const { sys, user } = makeFakeFS();
  try {
    // Seed discord with a manifest that infers kind=gateway (cadence:null + start fn).
    seedManifest(
      sys,
      'discord',
      `export const manifest = { name: 'discord', cadence: null, start: async () => {}, tools: [] };`,
    );
    // No scheduler.gateways field → fallback enables it.
    const out = await runMigrate({ db, systemDir: sys, userDataDir: user, daemonRunning: false });
    assert.equal(out.exitCode, 0);
    const state = await readIntegrationsState(db);
    assert.equal(
      state.states.discord?.enabled,
      true,
      'gateway fallback should auto-enable discord',
    );
  } finally {
    rmSync(sys, { recursive: true, force: true });
    rmSync(user, { recursive: true, force: true });
    await close(db);
  }
});

test('migrate skips already-moved integrations with warning', async () => {
  const db = await freshDb();
  const { sys, user } = makeFakeFS();
  try {
    seedManifest(sys, 'spotify');
    seedManifest(user, 'spotify'); // already exists at destination
    const out = await runMigrate({ db, systemDir: sys, userDataDir: user, daemonRunning: false });
    assert.equal(out.exitCode, 0);
    assert.ok(/spotify.*(already at destination|skipped)/i.test(out.stdout));
  } finally {
    rmSync(sys, { recursive: true, force: true });
    rmSync(user, { recursive: true, force: true });
    await close(db);
  }
});
