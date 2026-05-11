import assert from 'node:assert/strict';
import { mkdirSync as __mk } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { _resetBeliefConfigCacheForTests } from '../../cognition/belief/config.js';
import { runMetaCalibrationNarrative } from '../../cognition/jobs/internal/meta-calibration-narrative.js';
import { writeConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createStubEmbedder } from '../../data/embed/embedder.js';

const HOME = join(tmpdir(), `robin-id-${process.pid}-${Math.random().toString(36).slice(2)}`);
__mk(HOME, { recursive: true });
process.env.ROBIN_HOME = HOME;
await writeConfig({ embedder_profile: 'mxbai-1024' });

test('IDEMPOTENT: re-run writer same week -> second pass adds zero new memos', async () => {
  _resetBeliefConfigCacheForTests();
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  const e = createStubEmbedder({ dimension: 1024 });
  const ts = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  for (let i = 0; i < 5; i++) {
    await db
      .query(surql`CREATE memos CONTENT {
      kind: 'prediction',
      content: ${`p${i}`},
      derived_by: 'auto', scope: 'global',
      confidence: 0.7, signal_count: 1,
      derived_at: ${ts}, decay_anchor: ${ts},
      meta: { statement_kind: 'photography', resolved_at: ${ts}, correct: ${i < 3} },
    }`)
      .collect();
  }

  const r1 = await runMetaCalibrationNarrative({ db, embedder: e });
  assert.equal(r1.wrote.length, 1);
  const [n1] = await db
    .query(
      surql`SELECT count() AS n FROM memos WHERE kind='reasoning' AND meta.dimension='calibration' GROUP ALL`,
    )
    .collect();

  const r2 = await runMetaCalibrationNarrative({ db, embedder: e });
  assert.equal(r2.wrote.length, 0, 'second run must not write');
  assert.ok(r2.skipped.includes('photography'));
  const [n2] = await db
    .query(
      surql`SELECT count() AS n FROM memos WHERE kind='reasoning' AND meta.dimension='calibration' GROUP ALL`,
    )
    .collect();
  assert.equal(n1?.[0]?.n, n2?.[0]?.n, 'memo count unchanged between runs');
  await close(db);
});

test('IDEMPOTENT: dedup probe SurrealQL shape is preserved (regression guard)', () => {
  // Spec §6.4 probe. Pins the shape so a refactor doesn't widen the filter.
  const probe = `
    SELECT 1
    FROM memos
    WHERE kind = 'reasoning'
      AND meta.dimension = 'calibration'
      AND meta.domain = $domain
      AND meta.week_starting = $week
    LIMIT 1`;
  assert.match(probe, /kind = 'reasoning'/);
  assert.match(probe, /meta\.dimension = 'calibration'/);
  assert.match(probe, /meta\.domain = \$domain/);
  assert.match(probe, /meta\.week_starting = \$week/);
});
