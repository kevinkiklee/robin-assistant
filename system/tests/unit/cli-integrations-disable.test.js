import { strict as assert } from 'node:assert';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import test from 'node:test';
import { writeConfig as __robinWriteConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import {
  readIntegrationsState,
  setIntegrationEnabled,
} from '../../data/runtime/integrations-state.js';
import { runDisable } from '../../runtime/cli/commands/integrations-disable.js';

const __robinTestHome = __robinJoin(
  __robinTmpdir(),
  `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
);
__robinMkdirSync(__robinTestHome, { recursive: true });
process.env.ROBIN_HOME = __robinTestHome;
await __robinWriteConfig({ embedder_profile: 'mxbai-1024' });

async function freshDb() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  return db;
}

function fakeManifest(name, opts = {}) {
  return {
    name,
    kind: opts.kind ?? 'sync',
    cadence_ms: 60_000,
    _source: 'user-data',
    tools: opts.tools ?? [],
  };
}

test('disable: idempotent for already-disabled', async () => {
  const db = await freshDb();
  try {
    const ctx = { db, manifests: [fakeManifest('spotify')] };
    const out = await runDisable(ctx, ['spotify']);
    assert.equal(out.exitCode, 0);
    assert.ok(/no change/.test(out.stdout));
  } finally {
    await close(db);
  }
});

test('disable: flips enabled → false', async () => {
  const db = await freshDb();
  try {
    await setIntegrationEnabled(db, 'spotify', { enabled: true, source: 'user-data' });
    const ctx = { db, manifests: [fakeManifest('spotify')] };
    const out = await runDisable(ctx, ['spotify']);
    assert.equal(out.exitCode, 0);
    const state = await readIntegrationsState(db);
    assert.equal(state.states.spotify.enabled, false);
  } finally {
    await close(db);
  }
});

test('disable: prints restart-hint for gateway', async () => {
  const db = await freshDb();
  try {
    await setIntegrationEnabled(db, 'discord', { enabled: true, source: 'user-data' });
    const ctx = { db, manifests: [fakeManifest('discord', { kind: 'gateway' })] };
    const out = await runDisable(ctx, ['discord']);
    assert.equal(out.exitCode, 0);
    assert.ok(/restart daemon/.test(out.stdout));
  } finally {
    await close(db);
  }
});

test('disable: unknown name → exit 1, no state change', async () => {
  const db = await freshDb();
  try {
    const ctx = { db, manifests: [fakeManifest('spotify')] };
    const out = await runDisable(ctx, ['unknown']);
    assert.equal(out.exitCode, 1);
  } finally {
    await close(db);
  }
});
