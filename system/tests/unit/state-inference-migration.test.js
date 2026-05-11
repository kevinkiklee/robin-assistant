import assert from 'node:assert/strict';
import { mkdirSync as __mk } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { writeConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';

const HOME = join(tmpdir(), `robin-mig-${process.pid}-${Math.random().toString(36).slice(2)}`);
__mk(HOME, { recursive: true });
process.env.ROBIN_HOME = HOME;
await writeConfig({ embedder_profile: 'mxbai-1024' });

test('0012 migration applies cleanly and seeds runtime:state_inference.config', async () => {
  const db = await connect({ engine: 'mem://' });
  try {
    await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
    const [rows] = await db
      .query('SELECT VALUE value FROM runtime:`state_inference.config`')
      .collect();
    const cfg = rows?.[0];
    assert.ok(cfg, 'expected runtime:state_inference.config row');
    assert.equal(cfg.enabled, false);
    assert.equal(cfg.tick_ms, 300000);
    assert.equal(cfg.attention_window_min, 90);
    assert.equal(cfg.refresh_after_minutes, 30);
    assert.equal(cfg.max_sources_per_tick, 4);
    assert.equal(cfg.min_confidence_to_surface, 0.5);
    assert.equal(cfg.stale_after_minutes, 120);
  } finally {
    await close(db);
  }
});

test('state_inference_telemetry table is defined', async () => {
  const db = await connect({ engine: 'mem://' });
  try {
    await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
    // SurrealDB 3.x: `INFO FOR DB` returns tables under the `tb` key.
    // Rather than dig into the engine-specific shape (which can shift
    // between releases), assert the table is queryable: a SELECT against a
    // missing table throws. LIMIT 0 keeps it free.
    await db.query('SELECT 1 FROM state_inference_telemetry LIMIT 0').collect();
  } finally {
    await close(db);
  }
});
