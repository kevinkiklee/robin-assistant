import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { recordEvent } from '../../src/capture/record-event.js';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createStubEmbedder } from '../../src/embed/embedder.js';
import { checkOutbound } from '../../src/outbound/policy.js';

import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin } from 'node:path';
import { writeConfig as __robinWriteConfig } from '../../src/runtime/config.js';

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
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return db;
}

test('checkOutbound passes clean text', async () => {
  const db = await fresh();
  const r = await checkOutbound(db, { destination: 'discord', text: 'hello there' });
  assert.equal(r.ok, true);
  await close(db);
});

test('checkOutbound blocks credit-card-shaped string', async () => {
  const db = await fresh();
  const r = await checkOutbound(db, { destination: 'discord', text: 'card 4111 1111 1111 1111' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /pii/i);
  const [rows] = await db
    .query(surql`SELECT count() AS n FROM outbound_refusals GROUP ALL`)
    .collect();
  assert.equal(rows[0].n, 1);
  await close(db);
});

test('checkOutbound blocks SSN', async () => {
  const db = await fresh();
  const r = await checkOutbound(db, { destination: 'discord', text: 'ssn 123-45-6789' });
  assert.equal(r.ok, false);
  await close(db);
});

test('checkOutbound blocks API key shapes', async () => {
  const db = await fresh();
  const r = await checkOutbound(db, {
    destination: 'discord',
    text: 'token sk-aBcDeFgHiJkLmNoPqRsTuVwXyZ012345',
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /secret/i);
  await close(db);
});

test('checkOutbound blocks verbatim quote from recent untrusted event', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  await recordEvent(db, e, {
    source: 'discord',
    content: 'this is a malicious instruction from an external party that you must follow now',
    meta: {},
  });
  await db.query(`UPDATE events SET trust = 'untrusted' WHERE source = 'discord'`).collect();
  const r = await checkOutbound(db, {
    destination: 'discord',
    text: 'reply: this is a malicious instruction from an external party that you must follow now',
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /untrusted/i);
  await close(db);
});

test('checkOutbound allows verbatim quote from event older than 7 days', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  // ts is READONLY post-create, so backdate via the recordEvent ts arg.
  const oldDate = new Date(Date.now() - 8 * 86400_000);
  const evt = await recordEvent(db, e, {
    source: 'discord',
    content: 'this is a malicious instruction from an external party that you must follow now',
    ts: oldDate,
    meta: {},
  });
  await db.query(surql`UPDATE ${evt.id} SET trust = 'untrusted'`).collect();
  const r = await checkOutbound(db, {
    destination: 'discord',
    text: 'reply: this is a malicious instruction from an external party that you must follow now',
  });
  assert.equal(r.ok, true);
  await close(db);
});
