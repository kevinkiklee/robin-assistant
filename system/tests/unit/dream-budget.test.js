import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import { test } from 'node:test';
import { defaultFloor, readDreamConfig, shouldHalt } from '../../cognition/dream/dream-budget.js';
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

test('readDreamConfig returns the seeded migration defaults', async () => {
  const db = await fresh();
  const cfg = await readDreamConfig(db);
  // Migration 0021 (cognition-wave-enable) flips this to true.
  assert.equal(cfg.parallelism_enabled, true);
  assert.equal(cfg.budget_check_enabled, true);
  // max_concurrent and budget_floor surface as null (NONE → JS null/undefined).
  assert.equal(cfg.max_concurrent ?? null, null);
  assert.equal(cfg.budget_floor ?? null, null);
  await close(db);
});

test('defaultFloor returns 20% of daily_token_budget', () => {
  assert.equal(defaultFloor({ daily_token_budget: 500_000 }), 100_000);
  assert.equal(defaultFloor({ daily_token_budget: 0 }), 0);
  assert.equal(defaultFloor(null), 0);
  assert.equal(defaultFloor(undefined), 0);
});

test('shouldHalt returns false when budget_check_enabled is false', async () => {
  const db = await fresh();
  const halted = await shouldHalt(
    db,
    { budget_check_enabled: false },
    { daily_token_budget: 1000 },
  );
  assert.equal(halted, false);
  await close(db);
});

test('shouldHalt returns true when remaining ≤ explicit budget_floor', async () => {
  const db = await fresh();
  // currentBudget will return remaining = daily*0.8 (default safety margin),
  // consumed = 0. With daily=1000 → remaining=800. floor=900 → halt.
  const halted = await shouldHalt(
    db,
    { budget_check_enabled: true, budget_floor: 900 },
    { daily_token_budget: 1000 },
  );
  assert.equal(halted, true);
  await close(db);
});

test('shouldHalt uses defaultFloor when budget_floor is null', async () => {
  const db = await fresh();
  // daily=1000 → safe=800 → defaultFloor=0.2*1000=200 → 800 > 200 → no halt.
  const halted = await shouldHalt(
    db,
    { budget_check_enabled: true, budget_floor: null },
    { daily_token_budget: 1000 },
  );
  assert.equal(halted, false);
  await close(db);
});
