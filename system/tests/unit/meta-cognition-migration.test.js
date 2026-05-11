import assert from 'node:assert/strict';
import { mkdirSync as __mk } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { writeConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';

const HOME = join(tmpdir(), `robin-d2mig-${process.pid}-${Math.random().toString(36).slice(2)}`);
__mk(HOME, { recursive: true });
process.env.ROBIN_HOME = HOME;
await writeConfig({ embedder_profile: 'mxbai-1024' });

test('0018 migration seeds runtime:`meta_cognition.config` with defaults', async () => {
  const db = await connect({ engine: 'mem://' });
  try {
    await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
    const [rows] = await db
      .query('SELECT VALUE value FROM runtime:`meta_cognition.config`')
      .collect();
    const cfg = rows?.[0];
    assert.ok(cfg, 'expected runtime:meta_cognition.config row');
    // Migration 0021 (cognition-wave-enable) flips this to true.
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.min_corrections_threshold, 5);
    assert.equal(cfg.lookback_days, 7);
    assert.equal(cfg.max_corrected_rows, 200);
    assert.equal(cfg.max_unused_rows, 200);
    assert.equal(cfg.top_k_clusters, 3);
    assert.equal(cfg.min_cluster_size, 2);
    assert.ok(Math.abs(cfg.unused_signal_weight - 0.33) < 1e-9);
    assert.equal(cfg.tier, 'fast');
    assert.equal(cfg.max_tokens_in, 3000);
    assert.equal(cfg.max_tokens_out, 1200);
    assert.equal(cfg.max_rules_per_run, 3);
    assert.equal(cfg.weekly_token_budget, 6000);
    assert.equal(cfg.private_scope_action, 'drop');
    assert.equal(cfg.reasoning_memo_scope, 'global');
  } finally {
    await close(db);
  }
});

test('meta_cognition_telemetry table is queryable after migration', async () => {
  const db = await connect({ engine: 'mem://' });
  try {
    await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
    // SELECT against a missing table throws; LIMIT 0 keeps it free.
    await db.query('SELECT 1 FROM meta_cognition_telemetry LIMIT 0').collect();
  } finally {
    await close(db);
  }
});
