import assert from 'node:assert/strict';
import { mkdirSync as __mk } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { writeConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import {
  getSelfImprovementV2Config,
  isSelfImprovementV2Enabled,
  setSelfImprovementV2Enabled,
} from '../../runtime/config/self-improvement-v2.js';

const HOME = join(tmpdir(), `robin-siv2-${process.pid}-${Math.random().toString(36).slice(2)}`);
__mk(HOME, { recursive: true });
process.env.ROBIN_HOME = HOME;
await writeConfig({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  return db;
}

test('isSelfImprovementV2Enabled returns false when no row exists', async () => {
  const db = await fresh();
  // Ensure the row is absent.
  await db.query('DELETE runtime:`self-improvement-v2`').collect();
  const result = await isSelfImprovementV2Enabled(db);
  assert.equal(result, false);
  await close(db);
});

test('isSelfImprovementV2Enabled returns true after setSelfImprovementV2Enabled(db, true)', async () => {
  const db = await fresh();
  await setSelfImprovementV2Enabled(db, true);
  const result = await isSelfImprovementV2Enabled(db);
  assert.equal(result, true);
  await close(db);
});

test('setSelfImprovementV2Enabled(db, false) flips it back to false', async () => {
  const db = await fresh();
  await setSelfImprovementV2Enabled(db, true);
  assert.equal(await isSelfImprovementV2Enabled(db), true);
  await setSelfImprovementV2Enabled(db, false);
  assert.equal(await isSelfImprovementV2Enabled(db), false);
  await close(db);
});

test('getSelfImprovementV2Config returns full shape with defaults when row absent', async () => {
  const db = await fresh();
  await db.query('DELETE runtime:`self-improvement-v2`').collect();
  const cfg = await getSelfImprovementV2Config(db);
  assert.equal(typeof cfg, 'object');
  assert.equal(cfg.enabled, false);
  await close(db);
});

test('getSelfImprovementV2Config reflects current enabled state', async () => {
  const db = await fresh();
  await setSelfImprovementV2Enabled(db, true);
  const cfg = await getSelfImprovementV2Config(db);
  assert.equal(cfg.enabled, true);
  await close(db);
});
