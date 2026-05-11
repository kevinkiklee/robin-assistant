// Smoke tests for the full telemetry-rollup internal job entry: rollup +
// retention + pending hard-ceiling stages all wired together.

import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { writeConfig as __robinWriteConfig } from '../../config/paths.js';
import telemetryRollup from '../../cognition/jobs/internal/telemetry-rollup.js';
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
  const dir = resolve(import.meta.dirname, '../../data/db/migrations');
  await runMigrations(db, dir);
  return db;
}

test('telemetry-rollup runs rollup + retention stages and returns JSON', async () => {
  const db = await fresh();
  const now = new Date();
  await db
    .query(
      surql`CREATE intuition_telemetry CONTENT {
        ts: ${now}, latency_ms: 10, tokens_injected: 0, hits: 0, query_chars: 0,
        meta: { from: 'intuition' }
      }`,
    )
    .collect();
  const result = JSON.parse(await telemetryRollup({ db }));
  assert.ok(result.rollup);
  assert.ok(result.prune);
  // Intuition rollup branch should succeed.
  assert.equal(result.rollup.per_entry.intuition_telemetry?.ok, true);
  await close(db);
});

test('telemetry-rollup no-ops when enabled=false', async () => {
  const db = await fresh();
  await db
    .query("UPDATE runtime:`telemetry.config` SET value.enabled = false")
    .collect();
  const result = JSON.parse(await telemetryRollup({ db }));
  assert.equal(result.skipped, 'disabled');
  await close(db);
});

test('telemetry-rollup always exits cleanly even if one stage throws', async () => {
  const db = await fresh();
  // The meta_cognition_telemetry table is missing (D2 hasn't shipped).
  // That branch fails-soft; the overall job returns a JSON result.
  const result = JSON.parse(await telemetryRollup({ db }));
  assert.ok(result.rollup);
  assert.equal(result.rollup.per_entry.meta_cognition_telemetry?.ok, false);
  // Intuition still succeeded.
  assert.equal(result.rollup.per_entry.intuition_telemetry?.ok, true);
  await close(db);
});
