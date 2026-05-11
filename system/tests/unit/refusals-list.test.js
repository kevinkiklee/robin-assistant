import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { printRefusals } from '../../src/cli/commands/refusals-list.js';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
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

async function seed(db, rows) {
  for (const r of rows) {
    await db.query(surql`CREATE refusals CONTENT ${r}`).collect();
    // Ensure ordering by created_at is deterministic across rows.
    await new Promise((res) => setTimeout(res, 5));
  }
}

test('printRefusals prints (no refusals) on empty table', async () => {
  const db = await fresh();
  const lines = [];
  await printRefusals(db, (s) => lines.push(s));
  assert.deepEqual(lines, ['(no refusals)']);
  await close(db);
});

test('printRefusals lists header + 4 rows (2 inbound + 2 outbound)', async () => {
  const db = await fresh();
  await seed(db, [
    {
      content: 'sk-redacted',
      reason: 'secret:openai_key',
      direction: 'inbound',
      meta: { destination: 'memory', payload_hash: 'aaaaaaaaaaaaaaaa' },
    },
    {
      content: '4111-1111-1111-1111',
      reason: 'pii:credit_card',
      direction: 'outbound',
      meta: { destination: 'discord', payload_hash: 'bbbbbbbbbbbbbbbb' },
    },
    {
      content: 'eyJ.redacted',
      reason: 'secret:jwt',
      direction: 'inbound',
      meta: { destination: 'memory', payload_hash: 'cccccccccccccccc' },
    },
    {
      content: '123-45-6789',
      reason: 'pii:ssn',
      direction: 'outbound',
      meta: { destination: 'discord', payload_hash: 'dddddddddddddddd' },
    },
  ]);

  const lines = [];
  await printRefusals(db, (s) => lines.push(s));

  // 1 header + 4 rows
  assert.equal(lines.length, 5);
  assert.match(lines[0], /created_at/);
  assert.match(lines[0], /direction/);
  assert.match(lines[0], /destination/);
  assert.match(lines[0], /reason/);
  assert.match(lines[0], /hash/);

  // All 4 hashes appear in some row.
  const body = lines.slice(1).join('\n');
  for (const hash of [
    'aaaaaaaaaaaaaaaa',
    'bbbbbbbbbbbbbbbb',
    'cccccccccccccccc',
    'dddddddddddddddd',
  ]) {
    assert.match(body, new RegExp(hash));
  }
  // Inbound + outbound directions both surface.
  assert.match(body, /inbound/);
  assert.match(body, /outbound/);
  // Reasons surface.
  assert.match(body, /secret:openai_key/);
  assert.match(body, /pii:credit_card/);
  assert.match(body, /secret:jwt/);
  assert.match(body, /pii:ssn/);
  await close(db);
});
