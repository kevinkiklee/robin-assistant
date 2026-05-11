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
import { createStubEmbedder } from '../../data/embed/embedder.js';
import { RobinPiiRefusedError } from '../../io/capture/errors.js';
import { recordEvent } from '../../io/capture/record-event.js';

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

async function rowCount(db, table) {
  const [rows] = await db.query(`SELECT count() AS n FROM ${table} GROUP ALL`).collect();
  return rows && rows.length > 0 ? rows[0].n : 0;
}

test('recordEvent without guard ignores PII (back-compat)', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const r = await recordEvent(db, e, {
    source: 'manual',
    content: 'token sk-aBcDeFgHiJkLmNoPqRsTuVwXyZ012345',
  });
  assert.ok(r.id);
  assert.equal(await rowCount(db, 'events'), 1);
  assert.equal(await rowCount(db, 'refusals'), 0);
  await close(db);
});

test('recordEvent with guard refuses an OpenAI key and writes inbound refusal only', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  await assert.rejects(
    () =>
      recordEvent(db, e, {
        source: 'manual',
        content: 'token sk-aBcDeFgHiJkLmNoPqRsTuVwXyZ012345',
        guard: guardInboundContent,
      }),
    (err) => {
      assert.ok(err instanceof RobinPiiRefusedError, `got: ${err}`);
      assert.equal(err.name, 'RobinPiiRefusedError');
      assert.equal(err.reason, 'secret:openai_key');
      assert.match(err.message, /refused to store memory/);
      return true;
    },
  );
  assert.equal(await rowCount(db, 'events'), 0);
  assert.equal(await rowCount(db, 'refusals'), 1);
  const [rows] = await db
    .query(surql`SELECT direction, reason, meta FROM refusals LIMIT 1`)
    .collect();
  assert.equal(rows[0].direction, 'inbound');
  assert.equal(rows[0].meta?.destination, 'memory');
  assert.equal(rows[0].reason, 'secret:openai_key');
  await close(db);
});

test('recordEvent with guard passes clean content', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const r = await recordEvent(db, e, {
    source: 'manual',
    content: 'Karen wants to plant lavender in the south bed',
    guard: guardInboundContent,
  });
  assert.ok(r.id);
  assert.equal(await rowCount(db, 'events'), 1);
  assert.equal(await rowCount(db, 'refusals'), 0);
  await close(db);
});
