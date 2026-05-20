import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb, closeDb } from '../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../brain/memory/migrations/index.ts';
import { buildContext } from '../_runtime/context.ts';
import { getGoogleAccessToken } from './oauth-google.ts';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'robin-oauth-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

function setEnv(prefix: string) {
  process.env[`${prefix}_REFRESH_TOKEN`] = 'fake-refresh';
  process.env[`${prefix}_CLIENT_ID`] = 'cid';
  process.env[`${prefix}_CLIENT_SECRET`] = 'csec';
}

function clearEnv(prefix: string) {
  delete process.env[`${prefix}_REFRESH_TOKEN`];
  delete process.env[`${prefix}_CLIENT_ID`];
  delete process.env[`${prefix}_CLIENT_SECRET`];
}

test('oauth-google: throws when refresh token missing', async () => {
  const db = freshDb();
  const ctx = buildContext('gmail', db, null);
  clearEnv('GMAIL');
  await assert.rejects(getGoogleAccessToken(ctx, 'GMAIL'), /GMAIL_REFRESH_TOKEN/);
  closeDb(db);
});

test('oauth-google: refreshes token and caches', async () => {
  const db = freshDb();
  const ctx = buildContext('gmail', db, null);
  setEnv('GMAIL');
  let calls = 0;
  ctx.fetch = (async () => {
    calls++;
    return new Response(JSON.stringify({ access_token: 'access-1', expires_in: 3600, token_type: 'Bearer' }), { status: 200 });
  }) as typeof fetch;
  const t1 = await getGoogleAccessToken(ctx, 'GMAIL');
  assert.equal(t1, 'access-1');
  assert.equal(calls, 1);
  // Second call within expiry should hit cache, not fetch
  const t2 = await getGoogleAccessToken(ctx, 'GMAIL');
  assert.equal(t2, 'access-1');
  assert.equal(calls, 1);
  clearEnv('GMAIL');
  closeDb(db);
});

test('oauth-google: refetches when cached token is expired', async () => {
  const db = freshDb();
  const ctx = buildContext('gmail', db, null);
  setEnv('GMAIL');
  ctx.state.set('google_access_token', 'stale');
  ctx.state.set('google_access_token_expiry', String(Date.now() - 1000));
  ctx.fetch = (async () => new Response(JSON.stringify({ access_token: 'fresh', expires_in: 3600, token_type: 'Bearer' }), { status: 200 })) as typeof fetch;
  const t = await getGoogleAccessToken(ctx, 'GMAIL');
  assert.equal(t, 'fresh');
  clearEnv('GMAIL');
  closeDb(db);
});
