import assert from 'node:assert/strict';
import { mkdirSync as __mk } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import {
  _resetBeliefConfigCacheForTests,
  readBeliefConfig,
} from '../../cognition/belief/config.js';
import { writeConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';

const HOME = join(tmpdir(), `robin-bcfg-${process.pid}-${Math.random().toString(36).slice(2)}`);
__mk(HOME, { recursive: true });
process.env.ROBIN_HOME = HOME;
await writeConfig({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  _resetBeliefConfigCacheForTests();
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  return db;
}

test('readBeliefConfig: returns seeded defaults', async () => {
  const db = await fresh();
  const cfg = await readBeliefConfig(db);
  assert.equal(cfg.default_threshold, 0.6);
  assert.equal(cfg.soften_floor, 0.4);
  assert.equal(cfg.shadow_mode, true);
  assert.equal(cfg.telemetry_sample_rate, 1.0);
  await close(db);
});

test('readBeliefConfig: caches within TTL', async () => {
  const db = await fresh();
  const a = await readBeliefConfig(db);
  // Mutate the row directly.
  await db.query('UPDATE runtime:`belief.config` SET value.default_threshold = 0.7').collect();
  const b = await readBeliefConfig(db);
  // Within TTL: same object (cached).
  assert.equal(b.default_threshold, a.default_threshold);
  await close(db);
});
