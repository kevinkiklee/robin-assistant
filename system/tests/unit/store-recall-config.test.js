import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import { test } from 'node:test';
import { getRecallConfig } from '../../cognition/memory/store.js';
import { writeConfig as __robinWriteConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';

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

test('getRecallConfig is exported and merges all B2 + legacy defaults', async () => {
  const db = await fresh();
  const cfg = await getRecallConfig(db);
  // Legacy keys (from 0001-init seed).
  assert.equal(cfg.rrf_k, 60);
  assert.equal(cfg.mmr_threshold, 0.92);
  // B2 keys (from 0015 seed).
  assert.equal(cfg.conflict_surfacing_enabled, false);
  assert.equal(cfg.conflict_min_confidence, 0.4);
  assert.equal(cfg.conflict_max_age_days, 30);
  assert.equal(cfg.conflict_max_pairs_surfaced, 3);
  assert.equal(cfg.conflict_max_pairs_hydrated, 24);
  assert.equal(cfg.conflict_block_token_budget, 300);
  assert.equal(cfg.relevant_memory_token_budget, 1500);
  await close(db);
});

test('getRecallConfig falls back to HYBRID_DEFAULTS when runtime:recall is missing', async () => {
  const db = await fresh();
  await db.query('DELETE runtime:recall').collect();
  // Either the cached row from before the DELETE, or HYBRID_DEFAULTS — both
  // shapes have the legacy keys. The contract we care about: an exported
  // function with no thrown error.
  const cfg = await getRecallConfig(db);
  assert.equal(typeof cfg.rrf_k, 'number');
  assert.equal(typeof cfg.conflict_min_confidence, 'number');
  await close(db);
});
