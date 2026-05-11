import assert from 'node:assert/strict';
import { mkdirSync as __mk } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { validateMemoKind } from '../../cognition/memory/kind-registry.js';
import { writeConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';

const HOME = join(
  tmpdir(),
  `robin-belief-mig-${process.pid}-${Math.random().toString(36).slice(2)}`,
);
__mk(HOME, { recursive: true });
process.env.ROBIN_HOME = HOME;
await writeConfig({ embedder_profile: 'mxbai-1024' });

test('0019 migration applies cleanly and seeds runtime:belief.config', async () => {
  const db = await connect({ engine: 'mem://' });
  try {
    await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
    const [rows] = await db.query('SELECT VALUE value FROM runtime:`belief.config`').collect();
    const cfg = rows?.[0];
    assert.ok(cfg, 'expected runtime:belief.config row');
    assert.equal(cfg.default_threshold, 0.6);
    assert.equal(cfg.soften_floor, 0.4);
    assert.equal(cfg.relevance_threshold, 0.3);
    assert.equal(cfg.belief_overfetch_factor, 2.0);
    assert.equal(cfg.shadow_mode, true);
    assert.equal(cfg.telemetry_enabled, true);
    assert.equal(cfg.telemetry_sample_rate, 1.0);
    assert.equal(cfg.meta_narrative_enabled, true);
    assert.equal(cfg.meta_narrative_min_samples, 5);
    assert.equal(cfg.meta_narrative_drift_threshold, 0.15);
    assert.equal(cfg.meta_narrative_window_days, 7);
    assert.equal(cfg.meta_narrative_rule_threshold, 0.15);
    assert.equal(cfg.meta_narrative_rule_min_weeks, 2);
    assert.deepEqual(cfg.domain_entity_types, ['topic', 'project', 'library']);
  } finally {
    await close(db);
  }
});

test('reasoning kind tolerates meta keys used by D2 + D3 writers', () => {
  const payload = {
    content: 'Calibration drift for photography this week: brier=0.18, drift=-0.12.',
    derived_by: 'auto',
    meta: {
      dimension: 'calibration',
      from_signal: 'meta_cognition',
      domain: 'photography',
      brier: 0.18,
      drift: -0.12,
      accuracy: 0.6,
      mean_confidence: 0.48,
      samples: 17,
      trend: 'worsening',
      week_starting: '2026-05-10',
    },
  };
  const r = validateMemoKind('reasoning', payload);
  assert.equal(r.ok, true, JSON.stringify(r));
});
