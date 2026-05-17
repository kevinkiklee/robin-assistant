import { strict as assert } from 'node:assert';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import test from 'node:test';
import { writeConfig as __robinWriteConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import {
  readIntegrationsRev,
  readIntegrationsState,
  setIntegrationEnabled,
} from '../../data/runtime/integrations-state.js';

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

test('readIntegrationsState returns empty object when record absent', async () => {
  const db = await freshDb();
  try {
    const state = await readIntegrationsState(db);
    assert.deepEqual(state.states, {});
    assert.equal(state.rev, 0);
    assert.equal(state.migrated_at, null);
  } finally {
    await close(db);
  }
});

test('setIntegrationEnabled writes state and bumps rev', async () => {
  const db = await freshDb();
  try {
    await setIntegrationEnabled(db, 'spotify', { enabled: true, source: 'user-data' });
    const state = await readIntegrationsState(db);
    assert.equal(state.states.spotify.enabled, true);
    assert.equal(state.states.spotify.source, 'user-data');
    // Use the same DateTime-compat check approach as boot-gateway-tracking:
    // SurrealDB deserializes datetimes to its own DateTime class, not JS Date.
    const enabledAt = state.states.spotify.enabled_at;
    assert.ok(enabledAt != null);
    assert.ok(!Number.isNaN(new Date(String(enabledAt)).getTime()));
    assert.equal(state.rev, 1);

    await setIntegrationEnabled(db, 'spotify', { enabled: false, source: 'user-data' });
    const state2 = await readIntegrationsState(db);
    assert.equal(state2.states.spotify.enabled, false);
    assert.equal(state2.rev, 2);
  } finally {
    await close(db);
  }
});

test('readIntegrationsRev is cheap — returns just rev', async () => {
  const db = await freshDb();
  try {
    assert.equal(await readIntegrationsRev(db), 0);
    await setIntegrationEnabled(db, 'foo', { enabled: true, source: 'system' });
    assert.equal(await readIntegrationsRev(db), 1);
  } finally {
    await close(db);
  }
});

test('isEnabled returns false for unknown integration', async () => {
  const { isEnabled } = await import('../../data/runtime/integrations-state.js');
  assert.equal(isEnabled({ states: {} }, 'foo'), false);
  assert.equal(isEnabled({ states: { foo: { enabled: true } } }, 'foo'), true);
  assert.equal(isEnabled({ states: { foo: { enabled: false } } }, 'foo'), false);
});

test('setMigratedAt records migration timestamp', async () => {
  const db = await freshDb();
  try {
    const { setMigratedAt } = await import('../../data/runtime/integrations-state.js');
    const t = new Date();
    await setMigratedAt(db, t);
    const state = await readIntegrationsState(db);
    assert.ok(state.migrated_at != null);
    assert.ok(!Number.isNaN(new Date(String(state.migrated_at)).getTime()));
  } finally {
    await close(db);
  }
});
