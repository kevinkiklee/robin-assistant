import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { recordEvent } from '../../io/capture/record-event.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createStubEmbedder } from '../../data/embed/embedder.js';
import { listJournalEntries } from '../../cognition/memory/chronicle.js';
import { writeConfig as __robinWriteConfig } from '../../config/paths.js';

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

test('listJournalEntries returns only biographed + significant events', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });

  // short, biographed — content len < 50, no correction kind → filtered out
  const evt1 = await recordEvent(db, e, { source: 'cli', content: 'short' });
  await db.query(surql`UPDATE ${evt1.id} SET biographed_at = time::now()`).collect();

  // long, biographed → kept
  const evt2 = await recordEvent(db, e, {
    source: 'cli',
    content: 'a much longer event content that should pass the significance threshold easily',
  });
  await db.query(surql`UPDATE ${evt2.id} SET biographed_at = time::now()`).collect();

  // long, NOT biographed → filtered out
  await recordEvent(db, e, {
    source: 'cli',
    content:
      'another long event that is significant by length but never made it through the biographer',
  });

  const entries = await listJournalEntries(db);
  assert.equal(entries.length, 1);
  assert.match(entries[0].content, /longer/);
  await close(db);
});

test('listJournalEntries returns short corrections (correction kind bypasses len)', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });

  const evt = await recordEvent(db, e, {
    source: 'cli',
    content: 'no!',
    meta: { kind: 'correction' },
  });
  await db.query(surql`UPDATE ${evt.id} SET biographed_at = time::now()`).collect();

  const entries = await listJournalEntries(db);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].meta.kind, 'correction');
  await close(db);
});

test('listJournalEntries respects since/until window', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });

  const old = await recordEvent(db, e, {
    source: 'cli',
    content: 'a long old event content that is well past the significance threshold',
    ts: '2020-01-01T00:00:00Z',
  });
  await db.query(surql`UPDATE ${old.id} SET biographed_at = time::now()`).collect();

  const recent = await recordEvent(db, e, {
    source: 'cli',
    content: 'a long recent event content that is well past the significance threshold',
  });
  await db.query(surql`UPDATE ${recent.id} SET biographed_at = time::now()`).collect();

  const entries = await listJournalEntries(db, { since: '2024-01-01T00:00:00Z' });
  assert.equal(entries.length, 1);
  assert.match(entries[0].content, /recent/);
  await close(db);
});

test('listJournalEntries validates limit and minContentLen', async () => {
  const db = await fresh();
  await assert.rejects(() => listJournalEntries(db, { limit: 0 }), /limit out of range/);
  await assert.rejects(
    () => listJournalEntries(db, { minContentLen: -1 }),
    /minContentLen out of range/,
  );
  await close(db);
});
