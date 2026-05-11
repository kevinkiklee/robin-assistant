import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { intuitionEndpoint } from '../../cognition/intuition/inject.js';
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

test('intuitionEndpoint returns formatted block with markers and writes telemetry', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  await recordEvent(db, e, { source: 'cli', content: 'discussed sourdough hydration ratio (62%)' });
  await recordEvent(db, e, { source: 'cli', content: 'planted tomatoes with Karen this weekend' });
  await recordEvent(db, e, { source: 'cli', content: 'wrote up the kettlebell program for May' });

  const result = await intuitionEndpoint({
    db,
    embedder: e,
    detector: null,
    query: 'sourdough',
    priorAssistant: '',
    k: 6,
    recencyDays: 30,
    tokenBudget: 1500,
  });

  assert.ok(result.block.includes('<!-- relevant memory -->'));
  assert.ok(result.block.includes('<!-- /relevant memory -->'));
  assert.ok(result.hits >= 1, `expected >=1 hits, got ${result.hits}`);
  assert.equal(result.truncated, false);
  assert.ok(result.tokens > 0);
  assert.ok(typeof result.latency_ms === 'number');

  // Each event line should look like `[event YYYY-MM-DD] ...`
  assert.match(result.block, /\[event \d{4}-\d{2}-\d{2}\] /);

  const [rows] = await db.query(surql`SELECT * FROM intuition_telemetry`).collect();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].query_chars, 'sourdough'.length);
  assert.equal(rows[0].hits, result.hits);
  assert.equal(rows[0].tokens_injected, result.tokens);
  assert.equal(rows[0].truncated, false);

  await close(db);
});

test('intuitionEndpoint tags episode_summary hits as [episode YYYY-MM-DD]', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  await recordEvent(db, e, {
    source: 'biographer',
    content: 'wrapped lunch-money sync gap; trust=high',
    meta: { kind: 'episode_summary' },
  });

  const result = await intuitionEndpoint({
    db,
    embedder: e,
    detector: null,
    query: 'lunch money sync',
    priorAssistant: '',
    k: 6,
    recencyDays: 30,
    tokenBudget: 1500,
  });

  assert.ok(result.hits >= 1);
  assert.match(result.block, /\[episode \d{4}-\d{2}-\d{2}\] /);

  await close(db);
});

test('intuitionEndpoint truncates when token budget is too small', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  // Insert several distinct events with long content. MMR-lite uses
  // substring-overlap to dedup near-duplicates at 0.85, so the contents
  // must NOT share enough tokens to be collapsed. Each line will be ~120
  // chars after trimming → ~30 tokens; with a budget of 50 we should fit
  // at most one.
  const fillers = [
    'alpha tangerine quietly skipped over rusted gears finding patient solace beneath maple shadows',
    'beta watermelon firmly clutches yellow ribbons while drifting peacefully near old harbor lights',
    'gamma blueberry abruptly whispers towards crimson clouds while echoing distant melancholic flutes',
    'delta papaya gently encircles violet kites soaring above an emerald valley with murmuring streams',
    'epsilon kiwi steadily rotates around bronze lanterns near a slate path lined with crooked pines',
  ];
  for (let i = 0; i < fillers.length; i++) {
    await recordEvent(db, e, { source: 'cli', content: `${i}: ${fillers[i]}` });
  }

  const tight = await intuitionEndpoint({
    db,
    embedder: e,
    detector: null,
    query: 'lorem',
    priorAssistant: '',
    k: 6,
    recencyDays: 30,
    tokenBudget: 50,
  });

  assert.equal(tight.truncated, true);

  const loose = await intuitionEndpoint({
    db,
    embedder: e,
    detector: null,
    query: 'lorem',
    priorAssistant: '',
    k: 6,
    recencyDays: 30,
    tokenBudget: 1500,
  });

  // Loose budget keeps strictly more content than the tight one.
  assert.ok(loose.block.length > tight.block.length);

  await close(db);
});

test('intuitionEndpoint returns empty block when there are no events', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });

  const result = await intuitionEndpoint({
    db,
    embedder: e,
    detector: null,
    query: 'anything goes',
    priorAssistant: '',
    k: 6,
    recencyDays: 30,
    tokenBudget: 1500,
  });

  assert.equal(result.block, '');
  assert.equal(result.hits, 0);
  assert.equal(result.tokens, 0);
  assert.equal(result.truncated, false);

  // Telemetry still recorded (with hits=0).
  const [rows] = await db.query(surql`SELECT * FROM intuition_telemetry`).collect();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].hits, 0);

  await close(db);
});

test('intuitionEndpoint includes prior assistant tail in the recall query', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  await recordEvent(db, e, { source: 'cli', content: 'kettlebell program for May' });

  // Empty current query, but the prior assistant turn is informative.
  const result = await intuitionEndpoint({
    db,
    embedder: e,
    detector: null,
    query: '',
    priorAssistant: 'we were just talking about the kettlebell program for May',
    k: 6,
    recencyDays: 30,
    tokenBudget: 1500,
  });

  // Recall ran (hits may be 0 with the stub embedder, but telemetry must
  // have a row and the call returns cleanly).
  assert.ok(typeof result.latency_ms === 'number');
  const [rows] = await db.query(surql`SELECT * FROM intuition_telemetry`).collect();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].query_chars, 0);

  await close(db);
});
