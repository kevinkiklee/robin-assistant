import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { guardInboundContent } from '../../cognition/discretion/inbound-guard.js';
import { writeConfig as __robinWriteConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';

// __robin_test_home_setup__
const __robinTestHome = __robinJoin(
  __robinTmpdir(),
  `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
);
__robinMkdirSync(__robinTestHome, { recursive: true });
process.env.ROBIN_HOME = __robinTestHome;
await __robinWriteConfig({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  return db;
}

async function refusalCount(db) {
  const [rows] = await db.query(surql`SELECT count() AS n FROM refusals GROUP ALL`).collect();
  return rows && rows.length > 0 ? rows[0].n : 0;
}

test('guardInboundContent passes clean text without writing a refusal', async () => {
  const db = await fresh();
  const r = await guardInboundContent(db, 'Karen prefers oat milk in her coffee');
  assert.equal(r.ok, true);
  assert.equal(await refusalCount(db), 0);
  await close(db);
});

test('guardInboundContent blocks an OpenAI key and records inbound refusal', async () => {
  const db = await fresh();
  const r = await guardInboundContent(db, 'token sk-aBcDeFgHiJkLmNoPqRsTuVwXyZ012345');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'secret:openai_key');
  assert.equal(await refusalCount(db), 1);
  const [rows] = await db
    .query(surql`SELECT direction, reason, meta FROM refusals LIMIT 1`)
    .collect();
  assert.equal(rows[0].direction, 'inbound');
  assert.equal(rows[0].meta?.destination, 'memory');
  assert.equal(rows[0].reason, 'secret:openai_key');
  assert.equal(typeof rows[0].meta?.payload_hash, 'string');
  assert.equal(rows[0].meta.payload_hash.length, 16);
  await close(db);
});

test('guardInboundContent blocks a JWT', async () => {
  const db = await fresh();
  const jwt =
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
  const r = await guardInboundContent(db, `auth header: Bearer ${jwt}`);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'secret:jwt');
  assert.equal(await refusalCount(db), 1);
  await close(db);
});

test('guardInboundContent blocks a private-key PEM header', async () => {
  const db = await fresh();
  const r = await guardInboundContent(db, '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'secret:private_key_pem');
  await close(db);
});

test('guardInboundContent blocks a password assignment', async () => {
  const db = await fresh();
  const r = await guardInboundContent(db, 'password=hunter2hunter');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'secret:password_assignment');
  await close(db);
});

test('guardInboundContent does not block medical/financial mentions', async () => {
  const db = await fresh();
  // Card-shape and SSN-shape are outbound-only; inbound must allow them.
  const r1 = await guardInboundContent(db, 'card 4111 1111 1111 1111 ending in 1111');
  assert.equal(r1.ok, true);
  const r2 = await guardInboundContent(db, 'ssn 123-45-6789 on file');
  assert.equal(r2.ok, true);
  assert.equal(await refusalCount(db), 0);
  await close(db);
});
