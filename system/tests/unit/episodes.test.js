import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { closeEpisode, createEpisode, findActiveEpisode } from '../../cognition/memory/episodes.js';
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

test('findActiveEpisode returns null when none exist', async () => {
  const db = await fresh();
  const ep = await findActiveEpisode(db, 'cli');
  assert.equal(ep, null);
  await close(db);
});

test('createEpisode + findActiveEpisode round-trip', async () => {
  const db = await fresh();
  const created = await createEpisode(db, { source: 'cli' });
  assert.ok(created.id);
  const ep = await findActiveEpisode(db, 'cli');
  assert.ok(ep);
  assert.equal(String(ep.id), String(created.id));
  await close(db);
});

test('closeEpisode sets ended_at and summary; findActiveEpisode then returns null', async () => {
  const db = await fresh();
  const ep = await createEpisode(db, { source: 'cli' });
  await closeEpisode(db, ep.id, {
    endedAt: new Date('2026-05-09T13:00:00Z'),
    summary: 'morning work',
  });
  const [rows] = await db.query(surql`SELECT * FROM ${ep.id}`).collect();
  assert.ok(rows[0].ended_at);
  assert.equal(rows[0].summary, 'morning work');
  const active = await findActiveEpisode(db, 'cli');
  assert.equal(active, null);
  await close(db);
});

test('findActiveEpisode is scoped by source', async () => {
  const db = await fresh();
  await createEpisode(db, { source: 'cli' });
  await createEpisode(db, { source: 'manual' });
  const cliEp = await findActiveEpisode(db, 'cli');
  const manualEp = await findActiveEpisode(db, 'manual');
  assert.notEqual(String(cliEp.id), String(manualEp.id));
  assert.equal(cliEp.source, 'cli');
  assert.equal(manualEp.source, 'manual');
  await close(db);
});

test('createEpisode optionally takes a summary', async () => {
  const db = await fresh();
  const ep = await createEpisode(db, { source: 'cli', summary: 'initial summary' });
  const [rows] = await db.query(surql`SELECT * FROM ${ep.id}`).collect();
  assert.equal(rows[0].summary, 'initial summary');
  await close(db);
});
