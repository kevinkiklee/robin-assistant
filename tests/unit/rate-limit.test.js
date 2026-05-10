import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { checkRateLimit } from '../../src/outbound/rate-limit.js';

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return db;
}

test('first write proceeds', async () => {
  const db = await fresh();
  const r = await checkRateLimit(db, 'github_write');
  assert.equal(r.ok, true);
  assert.equal(r.used, 1);
  await close(db);
});

test('11th write refused with rate_limited (cap=10)', async () => {
  const db = await fresh();
  for (let i = 0; i < 10; i++) await checkRateLimit(db, 'github_write');
  const r = await checkRateLimit(db, 'github_write');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'rate_limited');
  assert.ok(r.wait_seconds > 0);
  await close(db);
});

test('env override GITHUB_WRITE_RATE_LIMIT=2', async () => {
  process.env.GITHUB_WRITE_RATE_LIMIT = '2';
  try {
    const db = await fresh();
    await checkRateLimit(db, 'github_write');
    await checkRateLimit(db, 'github_write');
    const r = await checkRateLimit(db, 'github_write');
    assert.equal(r.ok, false);
    await close(db);
  } finally {
    Reflect.deleteProperty(process.env, 'GITHUB_WRITE_RATE_LIMIT');
  }
});

test('malformed recent_writes (non-array) recovers', async () => {
  const db = await fresh();
  await db
    .query(
      "UPSERT type::record('runtime', 'outbound_rate') SET value = { github_write: { recent_writes: 'not-an-array' } }",
    )
    .collect();
  const r = await checkRateLimit(db, 'github_write');
  assert.equal(r.ok, true);
  await close(db);
});

test('per-tool isolation: github_write cap does not affect spotify_write', async () => {
  const db = await fresh();
  for (let i = 0; i < 10; i++) await checkRateLimit(db, 'github_write');
  const r = await checkRateLimit(db, 'spotify_write');
  assert.equal(r.ok, true);
  await close(db);
});
