// `polish-a4` invariants shipped with three never-passing bugs:
//
//   1. runtime.hot_reload_watcher_active — read `rows[0]` (the statement-
//      results array) instead of `rows[0][0]` (the first record). `.collect()`
//      returns [statement1Results, ...]; one level of unwrapping was missed.
//
//   2. daemon.embedder_load_age — same envelope bug reading `last_success_ts`.
//
//   3. mcp.daemon_authenticated_after_reconnect — called `db.connect()` with
//      no URL. Surreal v2.0.3 requires URL; throws inside parseEndpoint
//      (`Cannot read properties of undefined (reading 'href')`).
//
// This file is the regression net for all three.

import assert from 'node:assert';
import { test } from 'node:test';
import { close, connect } from '../../../data/db/client.js';
import daemonEmbedderLoadAge from '../../../runtime/invariants/daemon.embedder-load-age.js';
import mcpReconnect from '../../../runtime/invariants/mcp.daemon-authenticated-after-reconnect.js';
import hotReloadWatcher from '../../../runtime/invariants/runtime.hot-reload-watcher-active.js';

async function withMemDb(fn) {
  const db = await connect({ engine: 'mem://' });
  try {
    // Production schema defines runtime_state via migrations; mem:// is bare.
    // SELECT against an undefined table throws in v2.0.3, so define it here.
    await db.query('DEFINE TABLE runtime_state SCHEMALESS;').collect();
    await fn(db);
  } finally {
    await close(db);
  }
}

test('runtime.hot_reload_watcher_active returns ok when row.active=true', async () => {
  await withMemDb(async (db) => {
    await db
      .query(
        'UPSERT runtime_state:hot_reload_watcher CONTENT { active: true, registered_at: "2026-05-18T15:00:00Z" };',
      )
      .collect();
    const result = await hotReloadWatcher.check({ db });
    assert.strictEqual(result.ok, true, JSON.stringify(result));
    assert.strictEqual(result.evidence?.registered_at, '2026-05-18T15:00:00Z');
  });
});

test('runtime.hot_reload_watcher_active returns watcher_inactive when row.active=false', async () => {
  await withMemDb(async (db) => {
    await db
      .query(
        'UPSERT runtime_state:hot_reload_watcher CONTENT { active: false, registered_at: "2026-05-18T15:00:00Z" };',
      )
      .collect();
    const result = await hotReloadWatcher.check({ db });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, 'watcher_inactive');
  });
});

test('runtime.hot_reload_watcher_active returns watcher_not_registered when row missing', async () => {
  await withMemDb(async (db) => {
    const result = await hotReloadWatcher.check({ db });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, 'watcher_not_registered');
  });
});

test('daemon.embedder_load_age returns ok when row last_success_ts is fresh', async () => {
  await withMemDb(async (db) => {
    const recent = new Date(Date.now() - 60_000).toISOString();
    await db
      .query(
        `UPSERT runtime_state:embed_probe CONTENT { last_success_ts: "${recent}", last_error: NONE };`,
      )
      .collect();
    const result = await daemonEmbedderLoadAge.check({ db });
    assert.strictEqual(result.ok, true, JSON.stringify(result));
    assert.strictEqual(result.evidence?.last_success_ts, recent);
  });
});

test('daemon.embedder_load_age returns stale_embed_probe when older than 24h', async () => {
  await withMemDb(async (db) => {
    const old = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
    await db
      .query(
        `UPSERT runtime_state:embed_probe CONTENT { last_success_ts: "${old}", last_error: NONE };`,
      )
      .collect();
    const result = await daemonEmbedderLoadAge.check({ db });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, 'stale_embed_probe');
  });
});

test('daemon.embedder_load_age returns no_probe_record when row missing', async () => {
  await withMemDb(async (db) => {
    const result = await daemonEmbedderLoadAge.check({ db });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, 'no_probe_record');
  });
});

test('mcp.daemon_authenticated_after_reconnect uses db.__url to reconnect', async () => {
  // mem:// embedded engines don't actually need WS reconnection, but the
  // invariant's close+connect cycle still calls `db.connect(url)` — which now
  // succeeds because the client stashes `db.__url = engine` on initial connect.
  // Before the fix, this threw `Cannot read properties of undefined (reading
  // 'href')` from parseEndpoint(undefined).
  await withMemDb(async (db) => {
    assert.strictEqual(db.__url, 'mem://', 'expected client.js to stash db.__url');
    const result = await mcpReconnect.check({ db });
    // After fix: the close + connect(url) cycle succeeds, the SELECT returns 1,
    // invariant returns ok. Reactive retry layer would catch any anonymous
    // error on remote handles; mem:// doesn't require signin.
    assert.strictEqual(result.ok, true, JSON.stringify(result));
  });
});

test('mcp.daemon_authenticated_after_reconnect returns no_stashed_url when __url missing', async () => {
  // Synthetic db that fakes the surface without going through client.js.
  // Asserts the explicit guard fires rather than the v2.0.3 crash inside
  // parseEndpoint(undefined).
  const fakeDb = {
    close: async () => {},
    connect: async () => {
      throw new Error('must not reach connect() — fail guard should fire first');
    },
    query: () => ({ collect: async () => [[1]] }),
  };
  const result = await mcpReconnect.check({ db: fakeDb });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error, 'no_stashed_url');
});
