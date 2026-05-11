import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir as __robinTmpdir, tmpdir } from 'node:os';
import { join as __robinJoin, join, resolve } from 'node:path';
import { mock, test } from 'node:test';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createStubEmbedder } from '../../data/embed/embedder.js';
import { _resetCache } from '../../io/integrations/_auth/token-cache.js';
import { createCapture } from '../../io/integrations/_framework/capture.js';
import { createSpotifyWriteTool } from '../../io/integrations/spotify_write/tools/spotify-write.js';
import { getActionTrust, setActionTrust } from '../../cognition/jobs/action-trust.js';
import { writeConfig as __robinWriteConfig } from '../../config/paths.js';

// __robin_test_home_setup__
const __robinTestHome = __robinJoin(
  __robinTmpdir(),
  `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
);
__robinMkdirSync(__robinTestHome, { recursive: true });
process.env.ROBIN_HOME = __robinTestHome;
await __robinWriteConfig({ embedder_profile: 'mxbai-1024' });

let tmpHome;
test.beforeEach(() => {
  tmpHome = join(tmpdir(), `robin-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpHome, { recursive: true });
  process.env.ROBIN_HOME = tmpHome;
  writeFileSync(join(tmpHome, 'config.json'), JSON.stringify({ embedder_profile: 'mxbai-1024' }));
  _resetCache('spotify');
});
test.afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

async function freshSetup() {
  const { saveSecret } = await import(`../../src/secrets/dotenv-io.js?cb=${Date.now()}`);
  saveSecret('SPOTIFY_REFRESH_TOKEN', 'r');
  saveSecret('SPOTIFY_CLIENT_ID', 'cid');
  saveSecret('SPOTIFY_CLIENT_SECRET', 'csec');
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  const e = createStubEmbedder({ dimension: 1024 });
  const capture = createCapture({
    db,
    embedder: e,
    source: 'spotify_write',
    embed: true,
    mode: 'insert-or-skip',
  });
  return { db, capture };
}

function spotifyFetchStub({ tokenResp, apiResp, apiStatus = 204 } = {}) {
  return mock.fn(async (url) => {
    if (url.includes('accounts.spotify.com/api/token')) {
      return {
        ok: true,
        json: async () => tokenResp ?? { access_token: 'tok', expires_in: 3600 },
      };
    }
    if (url.includes('api.spotify.com')) {
      return {
        ok: apiStatus < 400,
        status: apiStatus,
        json: async () => apiResp ?? null,
        text: async () => (apiResp ? JSON.stringify(apiResp) : ''),
      };
    }
    throw new Error(`unexpected: ${url}`);
  });
}

// --- Default ASK gate (first-call, no trust row) ---

test('queue: first call defaults to ASK → requires_permission', async () => {
  const { db, capture } = await freshSetup();
  try {
    const t = createSpotifyWriteTool({ db, capture });
    const r = await t.handler({ action: 'queue', args: { track_uri: 'spotify:track:abc' } });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'requires_permission');
    assert.equal(r.class, 'spotify_write:queue');
    assert.ok(r.last_state_change_at instanceof Date);
  } finally {
    await close(db);
  }
});

test('skip: first call defaults to ASK → requires_permission', async () => {
  const { db, capture } = await freshSetup();
  try {
    const t = createSpotifyWriteTool({ db, capture });
    const r = await t.handler({ action: 'skip', args: {} });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'requires_permission');
    assert.equal(r.class, 'spotify_write:skip');
  } finally {
    await close(db);
  }
});

test('playlist-add: first call defaults to ASK → requires_permission', async () => {
  const { db, capture } = await freshSetup();
  try {
    const t = createSpotifyWriteTool({ db, capture });
    const r = await t.handler({
      action: 'playlist-add',
      args: { playlist_id: 'pl1', track_uris: ['t1'] },
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'requires_permission');
    assert.equal(r.class, 'spotify_write:playlist-add');
  } finally {
    await close(db);
  }
});

// --- ASK + force:true proceeds ---

test('queue: ASK + force:true proceeds', async () => {
  const { db, capture } = await freshSetup();
  const restore = mock.method(globalThis, 'fetch', spotifyFetchStub({}));
  try {
    const t = createSpotifyWriteTool({ db, capture });
    const r = await t.handler({
      action: 'queue',
      args: { track_uri: 'spotify:track:abc', force: true },
    });
    assert.equal(r.ok, true);
    assert.equal(r.queued, 'spotify:track:abc');
  } finally {
    restore.mock.restore();
    await close(db);
  }
});

test('skip: ASK + force:true proceeds', async () => {
  const { db, capture } = await freshSetup();
  const restore = mock.method(globalThis, 'fetch', spotifyFetchStub({}));
  try {
    const t = createSpotifyWriteTool({ db, capture });
    const r = await t.handler({ action: 'skip', args: { force: true } });
    assert.equal(r.ok, true);
  } finally {
    restore.mock.restore();
    await close(db);
  }
});

test('playlist-add: ASK + force:true proceeds', async () => {
  const { db, capture } = await freshSetup();
  const restore = mock.method(
    globalThis,
    'fetch',
    spotifyFetchStub({ apiStatus: 201, apiResp: { snapshot_id: 'snap-1' } }),
  );
  try {
    const t = createSpotifyWriteTool({ db, capture });
    const r = await t.handler({
      action: 'playlist-add',
      args: { playlist_id: 'pl1', track_uris: ['t1', 't2'], force: true },
    });
    assert.equal(r.ok, true);
    assert.equal(r.count, 2);
  } finally {
    restore.mock.restore();
    await close(db);
  }
});

// --- AUTO proceeds without force ---

test('queue: AUTO proceeds without force', async () => {
  const { db, capture } = await freshSetup();
  await setActionTrust(db, 'spotify_write:queue', 'AUTO', 'user');
  const restore = mock.method(globalThis, 'fetch', spotifyFetchStub({}));
  try {
    const t = createSpotifyWriteTool({ db, capture });
    const r = await t.handler({ action: 'queue', args: { track_uri: 'spotify:track:xyz' } });
    assert.equal(r.ok, true);
  } finally {
    restore.mock.restore();
    await close(db);
  }
});

test('skip: AUTO proceeds without force', async () => {
  const { db, capture } = await freshSetup();
  await setActionTrust(db, 'spotify_write:skip', 'AUTO', 'user');
  const restore = mock.method(globalThis, 'fetch', spotifyFetchStub({}));
  try {
    const t = createSpotifyWriteTool({ db, capture });
    const r = await t.handler({ action: 'skip', args: {} });
    assert.equal(r.ok, true);
  } finally {
    restore.mock.restore();
    await close(db);
  }
});

test('playlist-add: AUTO proceeds without force', async () => {
  const { db, capture } = await freshSetup();
  await setActionTrust(db, 'spotify_write:playlist-add', 'AUTO', 'user');
  const restore = mock.method(
    globalThis,
    'fetch',
    spotifyFetchStub({ apiStatus: 201, apiResp: { snapshot_id: 'snap-2' } }),
  );
  try {
    const t = createSpotifyWriteTool({ db, capture });
    const r = await t.handler({
      action: 'playlist-add',
      args: { playlist_id: 'pl2', track_uris: ['t1'] },
    });
    assert.equal(r.ok, true);
  } finally {
    restore.mock.restore();
    await close(db);
  }
});

// --- NEVER refuses even with force ---

test('queue: NEVER refuses with force:true → action_not_allowed', async () => {
  const { db, capture } = await freshSetup();
  await setActionTrust(db, 'spotify_write:queue', 'NEVER', 'user');
  try {
    const t = createSpotifyWriteTool({ db, capture });
    const r = await t.handler({
      action: 'queue',
      args: { track_uri: 'spotify:track:abc', force: true },
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'action_not_allowed');
    assert.equal(r.class, 'spotify_write:queue');
  } finally {
    await close(db);
  }
});

test('skip: NEVER refuses with force:true → action_not_allowed', async () => {
  const { db, capture } = await freshSetup();
  await setActionTrust(db, 'spotify_write:skip', 'NEVER', 'user');
  try {
    const t = createSpotifyWriteTool({ db, capture });
    const r = await t.handler({ action: 'skip', args: { force: true } });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'action_not_allowed');
    assert.equal(r.class, 'spotify_write:skip');
  } finally {
    await close(db);
  }
});

test('playlist-add: NEVER refuses with force:true → action_not_allowed', async () => {
  const { db, capture } = await freshSetup();
  await setActionTrust(db, 'spotify_write:playlist-add', 'NEVER', 'user');
  try {
    const t = createSpotifyWriteTool({ db, capture });
    const r = await t.handler({
      action: 'playlist-add',
      args: { playlist_id: 'pl1', track_uris: ['t1'], force: true },
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'action_not_allowed');
    assert.equal(r.class, 'spotify_write:playlist-add');
  } finally {
    await close(db);
  }
});

// --- Successful call increments success_count ---

test('queue: successful call increments success_count', async () => {
  const { db, capture } = await freshSetup();
  await setActionTrust(db, 'spotify_write:queue', 'AUTO', 'user');
  const restore = mock.method(globalThis, 'fetch', spotifyFetchStub({}));
  try {
    const t = createSpotifyWriteTool({ db, capture });
    await t.handler({ action: 'queue', args: { track_uri: 'spotify:track:abc' } });
    await t.handler({ action: 'queue', args: { track_uri: 'spotify:track:def' } });
    const row = await getActionTrust(db, 'spotify_write:queue');
    assert.equal(row.success_count, 2);
  } finally {
    restore.mock.restore();
    await close(db);
  }
});

test('skip: successful call increments success_count', async () => {
  const { db, capture } = await freshSetup();
  await setActionTrust(db, 'spotify_write:skip', 'AUTO', 'user');
  const restore = mock.method(globalThis, 'fetch', spotifyFetchStub({}));
  try {
    const t = createSpotifyWriteTool({ db, capture });
    await t.handler({ action: 'skip', args: {} });
    const row = await getActionTrust(db, 'spotify_write:skip');
    assert.equal(row.success_count, 1);
  } finally {
    restore.mock.restore();
    await close(db);
  }
});

test('playlist-add: successful call increments success_count', async () => {
  const { db, capture } = await freshSetup();
  await setActionTrust(db, 'spotify_write:playlist-add', 'AUTO', 'user');
  const restore = mock.method(
    globalThis,
    'fetch',
    spotifyFetchStub({ apiStatus: 201, apiResp: { snapshot_id: 'snap-3' } }),
  );
  try {
    const t = createSpotifyWriteTool({ db, capture });
    await t.handler({
      action: 'playlist-add',
      args: { playlist_id: 'pl1', track_uris: ['t1'] },
    });
    const row = await getActionTrust(db, 'spotify_write:playlist-add');
    assert.equal(row.success_count, 1);
  } finally {
    restore.mock.restore();
    await close(db);
  }
});

// --- Class isolation: queue AUTO does NOT affect playlist-add ---

test('queue AUTO does NOT affect spotify_write:playlist-add trust row', async () => {
  const { db, capture } = await freshSetup();
  await setActionTrust(db, 'spotify_write:queue', 'AUTO', 'user');
  const restore = mock.method(globalThis, 'fetch', spotifyFetchStub({}));
  try {
    const t = createSpotifyWriteTool({ db, capture });
    // queue succeeds (AUTO)
    await t.handler({ action: 'queue', args: { track_uri: 'spotify:track:abc' } });
    // playlist-add should still be ASK (never set)
    const r = await t.handler({
      action: 'playlist-add',
      args: { playlist_id: 'pl1', track_uris: ['t1'] },
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'requires_permission');
    assert.equal(r.class, 'spotify_write:playlist-add');
    // queue's success_count should be 1; playlist-add's should be 0 or row absent
    const queueRow = await getActionTrust(db, 'spotify_write:queue');
    assert.equal(queueRow.success_count, 1);
  } finally {
    restore.mock.restore();
    await close(db);
  }
});
