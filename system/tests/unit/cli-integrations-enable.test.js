import { strict as assert } from 'node:assert';
import { resolve } from 'node:path';
import test from 'node:test';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { readIntegrationsState } from '../../data/runtime/integrations-state.js';
import { runEnable } from '../../runtime/cli/commands/integrations-enable.js';

async function freshDb() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  return db;
}

function fakeManifest(name, opts = {}) {
  return {
    name,
    kind: opts.kind ?? 'sync',
    cadence_ms: opts.cadence_ms ?? 60_000,
    _source: opts.source ?? 'user-data',
    preflight: opts.preflight,
    tools: opts.tools ?? [],
    start: opts.start,
  };
}

test('enable: unknown name returns user-error exit code', async () => {
  const db = await freshDb();
  try {
    const out = await runEnable({ db, manifests: [fakeManifest('spotify')] }, ['unknown']);
    assert.equal(out.exitCode, 1);
    assert.ok(/not installed/.test(out.stderr));
  } finally {
    await close(db);
  }
});

test('enable: idempotent for already-enabled', async () => {
  const db = await freshDb();
  try {
    const ctx = { db, manifests: [fakeManifest('spotify')] };
    await runEnable(ctx, ['spotify']);
    const out = await runEnable(ctx, ['spotify']);
    assert.equal(out.exitCode, 0);
    assert.ok(/no change/.test(out.stdout));
  } finally {
    await close(db);
  }
});

test('enable: warns on preflight failure but does not block', async () => {
  const db = await freshDb();
  try {
    const ctx = {
      db,
      manifests: [
        fakeManifest('spotify', {
          preflight: async () => {
            throw new Error('missing token');
          },
        }),
      ],
    };
    const out = await runEnable(ctx, ['spotify']);
    assert.equal(out.exitCode, 0);
    assert.ok(/preflight failed: missing token/.test(out.stdout));
    const state = await readIntegrationsState(db);
    assert.equal(state.states.spotify.enabled, true);
  } finally {
    await close(db);
  }
});

test('enable: prints restart-hint for gateway integrations', async () => {
  const db = await freshDb();
  try {
    const ctx = {
      db,
      manifests: [fakeManifest('discord', { kind: 'gateway', cadence_ms: null, start: () => {} })],
    };
    const out = await runEnable(ctx, ['discord']);
    assert.equal(out.exitCode, 0);
    assert.ok(/restart daemon/.test(out.stdout));
  } finally {
    await close(db);
  }
});

test('enable: prints restart-hint for tool-only integrations', async () => {
  const db = await freshDb();
  try {
    const ctx = {
      db,
      manifests: [
        fakeManifest('github_write', { kind: 'tool-only', cadence_ms: null, tools: [() => {}] }),
      ],
    };
    const out = await runEnable(ctx, ['github_write']);
    assert.equal(out.exitCode, 0);
    assert.ok(/restart daemon/.test(out.stdout));
  } finally {
    await close(db);
  }
});

test('enable: all-or-nothing when one name is invalid', async () => {
  const db = await freshDb();
  try {
    const ctx = { db, manifests: [fakeManifest('spotify'), fakeManifest('whoop')] };
    const out = await runEnable(ctx, ['spotify', 'unknown']);
    assert.equal(out.exitCode, 1);
    const state = await readIntegrationsState(db);
    assert.equal(state.states.spotify, undefined, 'no integration should have been enabled');
  } finally {
    await close(db);
  }
});
