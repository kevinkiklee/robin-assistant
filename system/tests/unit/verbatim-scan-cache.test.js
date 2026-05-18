import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import { test } from 'node:test';
import {
  __resetCacheForTests,
  scanForVerbatimQuote,
} from '../../cognition/discretion/verbatim-scan.js';
import { writeConfig as __robinWriteConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createStubEmbedder } from '../../data/embed/embedder.js';
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
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  return db;
}

test('detects verbatim 10-word overlap', async () => {
  __resetCacheForTests();
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  await recordEvent(db, e, {
    source: 'discord',
    content: 'one two three four five six seven eight nine ten eleven twelve',
    meta: {},
  });
  await db.query(`UPDATE events SET trust = 'untrusted' WHERE source = 'discord'`).collect();
  const result = await scanForVerbatimQuote(
    db,
    'reply: one two three four five six seven eight nine ten eleven twelve end',
  );
  assert.equal(result.found, true);
  assert.ok(result.eventId, 'should return eventId');
  assert.ok(result.shingle, 'should return matching shingle');
  await close(db);
});

test('no hit for unrelated text', async () => {
  __resetCacheForTests();
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  await recordEvent(db, e, {
    source: 'discord',
    content: 'one two three four five six seven eight nine ten',
    meta: {},
  });
  await db.query(`UPDATE events SET trust = 'untrusted' WHERE source = 'discord'`).collect();
  const result = await scanForVerbatimQuote(
    db,
    'completely different words here nothing matches at all',
  );
  assert.equal(result.found, false);
  await close(db);
});

test('cache invalidated when new untrusted event lands', async () => {
  __resetCacheForTests();
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });

  // First scan — empty DB, no match
  const r1 = await scanForVerbatimQuote(
    db,
    'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo',
  );
  assert.equal(r1.found, false);

  // Insert an untrusted event with matching content
  await recordEvent(db, e, {
    source: 'discord',
    content: 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo',
    meta: {},
  });
  await db.query(`UPDATE events SET trust = 'untrusted' WHERE source = 'discord'`).collect();

  // Second scan — cache should have been invalidated by the new max id
  const r2 = await scanForVerbatimQuote(
    db,
    'reply: alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo end',
  );
  assert.equal(r2.found, true);
  await close(db);
});
