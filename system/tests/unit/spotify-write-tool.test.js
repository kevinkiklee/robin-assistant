import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir as __robinTmpdir, tmpdir } from 'node:os';
import { join as __robinJoin, join, resolve } from 'node:path';
import { mock, test } from 'node:test';
import { setActionTrust } from '../../cognition/jobs/action-trust.js';
import { writeConfig as __robinWriteConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createStubEmbedder } from '../../data/embed/embedder.js';
import { _resetCache } from '../../io/integrations/_auth/token-cache.js';
import { createCapture } from '../../io/integrations/_framework/capture.js';
import { createSpotifyWriteTool } from '../../io/integrations/spotify_write/tools/spotify-write.js';

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
  // Pre-seed all 3 actions to AUTO so existing tests bypass the trust gate.
  await setActionTrust(db, 'spotify_write:queue', 'AUTO', 'user');
  await setActionTrust(db, 'spotify_write:skip', 'AUTO', 'user');
  await setActionTrust(db, 'spotify_write:playlist-add', 'AUTO', 'user');
  return { db, capture };
}

function spotifyFetchStub({ tokenResp, apiResp, apiStatus = 204 }) {
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

test('queue happy path', async () => {
  const { db, capture } = await freshSetup();
  const restore = mock.method(globalThis, 'fetch', spotifyFetchStub({}));
  try {
    const t = createSpotifyWriteTool({ db, capture });
    const r = await t.handler({ action: 'queue', args: { track_uri: '4iV5W9uYEdYUVa79Axb7Rh' } });
    assert.equal(r.ok, true);
  } finally {
    restore.mock.restore();
    await close(db);
  }
});

test('skip happy path', async () => {
  const { db, capture } = await freshSetup();
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

test('playlist-add happy path captures event', async () => {
  const { db, capture } = await freshSetup();
  const restore = mock.method(
    globalThis,
    'fetch',
    spotifyFetchStub({
      apiStatus: 201,
      apiResp: { snapshot_id: 'snap-1' },
    }),
  );
  try {
    const t = createSpotifyWriteTool({ db, capture });
    const r = await t.handler({
      action: 'playlist-add',
      args: { playlist_id: 'pl1', track_uris: ['t1', 't2'] },
    });
    assert.equal(r.ok, true);
    assert.equal(r.count, 2);
  } finally {
    restore.mock.restore();
    await close(db);
  }
});

test('queue missing track_uri', async () => {
  const { db, capture } = await freshSetup();
  const t = createSpotifyWriteTool({ db, capture });
  const r = await t.handler({ action: 'queue', args: {} });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'missing_arg');
  await close(db);
});

test('queue 404 → no_active_device', async () => {
  const { db, capture } = await freshSetup();
  const restore = mock.method(globalThis, 'fetch', spotifyFetchStub({ apiStatus: 404 }));
  try {
    const t = createSpotifyWriteTool({ db, capture });
    const r = await t.handler({ action: 'queue', args: { track_uri: 'abc' } });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no_active_device');
  } finally {
    restore.mock.restore();
    await close(db);
  }
});

test('queue 403 with "premium" → premium_required', async () => {
  const { db, capture } = await freshSetup();
  const restore = mock.method(globalThis, 'fetch', async (url) => {
    if (url.includes('accounts.spotify.com/api/token')) {
      return { ok: true, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
    }
    return { ok: false, status: 403, text: async () => 'Premium required', json: async () => null };
  });
  try {
    const t = createSpotifyWriteTool({ db, capture });
    const r = await t.handler({ action: 'queue', args: { track_uri: 'abc' } });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'premium_required');
  } finally {
    restore.mock.restore();
    await close(db);
  }
});

test('playlist-add 101 tracks → too_many_tracks', async () => {
  const { db, capture } = await freshSetup();
  const t = createSpotifyWriteTool({ db, capture });
  const r = await t.handler({
    action: 'playlist-add',
    args: { playlist_id: 'pl1', track_uris: Array.from({ length: 101 }, (_, i) => `t${i}`) },
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'too_many_tracks');
  await close(db);
});

test('rate-limit refusal short-circuits before policy', async () => {
  const { db, capture } = await freshSetup();
  process.env.SPOTIFY_WRITE_RATE_LIMIT = '1';
  try {
    const restore = mock.method(globalThis, 'fetch', spotifyFetchStub({}));
    try {
      const t = createSpotifyWriteTool({ db, capture });
      // First call passes; second is rate-limited
      await t.handler({ action: 'skip', args: {} });
      const r = await t.handler({ action: 'skip', args: {} });
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'rate_limited');
    } finally {
      restore.mock.restore();
    }
  } finally {
    Reflect.deleteProperty(process.env, 'SPOTIFY_WRITE_RATE_LIMIT');
    await close(db);
  }
});

test('unknown action → unknown_action', async () => {
  const { db, capture } = await freshSetup();
  const restore = mock.method(globalThis, 'fetch', spotifyFetchStub({}));
  try {
    const t = createSpotifyWriteTool({ db, capture });
    const r = await t.handler({ action: 'zoom', args: {} });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'unknown_action');
  } finally {
    restore.mock.restore();
    await close(db);
  }
});

test('missing secret → not_authenticated', async () => {
  // Don't seed secrets — buildSecrets should throw "missing secret"
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
  // Pre-seed AUTO so the trust gate passes before reaching the secret check.
  await setActionTrust(db, 'spotify_write:skip', 'AUTO', 'user');
  const t = createSpotifyWriteTool({ db, capture });
  const r = await t.handler({ action: 'skip', args: {} });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not_authenticated');
  await close(db);
});
