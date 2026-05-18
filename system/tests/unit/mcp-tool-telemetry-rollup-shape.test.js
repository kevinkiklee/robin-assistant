// Snapshot-shape test for show_telemetry_rollup. Asserts:
//   - default call hides zero-call faculties in `buckets`
//   - verbose: true includes every canonical faculty
//   - per-faculty summary shape matches reshapeTelemetryRollup output
//
// Uses an in-memory db with the migration set so the shadow-mode flip and
// telemetry_hourly schema match production. Keeps to mem:// + close pairing
// per the test-fast guidance in CLAUDE.md.

import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { surql } from 'surrealdb';
import { writeConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { FACULTIES } from '../../io/format/telemetry-rollup.js';
import { createShowTelemetryRollupTool } from '../../io/mcp/tools/show-telemetry-rollup.js';

const home = join(tmpdir(), `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
mkdirSync(home, { recursive: true });
process.env.ROBIN_HOME = home;
await writeConfig({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  const dir = resolve(import.meta.dirname, '../../data/db/migrations');
  await runMigrations(db, dir);
  await db.query('UPDATE runtime:`telemetry.config` SET value.shadow_mode = false').collect();
  return db;
}

function payload(out) {
  return JSON.parse(out.content?.[0]?.text ?? '{}');
}

test.after(() => {
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

test('show_telemetry_rollup default hides zero-call faculties in buckets', async () => {
  const db = await fresh();
  const now = new Date();
  // Two non-zero faculties present in telemetry_hourly.
  await db
    .query(
      surql`CREATE telemetry_hourly CONTENT {
        hour: ${now}, faculty: 'biographer', event_kind: 'run',
        count: 7, dimensions: {}, metric_sums: { latency_ms_sum: 1400 }, metric_buckets: {}
      }`,
    )
    .collect();
  await db
    .query(
      surql`CREATE telemetry_hourly CONTENT {
        hour: ${now}, faculty: 'intuition', event_kind: 'recall',
        count: 3, dimensions: {}, metric_sums: { latency_ms_sum: 300 }, metric_buckets: {}
      }`,
    )
    .collect();

  const tool = createShowTelemetryRollupTool({ db });
  const out = await tool.handler({});
  const p = payload(out);

  assert.ok(Array.isArray(p.rows), 'rows is preserved on the response');
  assert.ok(Array.isArray(p.buckets), 'buckets summary is on the response');
  // Non-zero faculties only — every other canonical faculty hidden.
  assert.equal(p.buckets.length, 2);
  const byFaculty = Object.fromEntries(p.buckets.map((b) => [b.faculty, b]));
  assert.equal(byFaculty.biographer.calls, 7);
  assert.equal(byFaculty.biographer.avg_latency_ms, 200);
  assert.equal(byFaculty.intuition.calls, 3);
  assert.equal(byFaculty.intuition.avg_latency_ms, 100);
  // Shape contract — each bucket exposes exactly these keys.
  for (const b of p.buckets) {
    assert.deepStrictEqual(Object.keys(b).sort(), [
      'avg_latency_ms',
      'calls',
      'cost_usd',
      'errors',
      'faculty',
    ]);
  }
  await close(db);
});

test('show_telemetry_rollup verbose:true exposes every canonical faculty', async () => {
  const db = await fresh();
  const now = new Date();
  await db
    .query(
      surql`CREATE telemetry_hourly CONTENT {
        hour: ${now}, faculty: 'biographer', event_kind: 'run',
        count: 4, dimensions: {}, metric_sums: {}, metric_buckets: {}
      }`,
    )
    .collect();

  const tool = createShowTelemetryRollupTool({ db });
  const out = await tool.handler({ verbose: true });
  const p = payload(out);

  // Every faculty in the canonical list — zero-call ones materialize as zero.
  assert.equal(p.buckets.length, FACULTIES.length);
  const byFaculty = Object.fromEntries(p.buckets.map((b) => [b.faculty, b]));
  assert.equal(byFaculty.biographer.calls, 4);
  assert.equal(byFaculty.reinforcement.calls, 0);
  assert.equal(byFaculty.belief.calls, 0);
  assert.equal(byFaculty.dream_layer.calls, 0);
  assert.equal(byFaculty.meta_cognition.calls, 0);
  assert.equal(byFaculty.state_inference.calls, 0);
  await close(db);
});

test('show_telemetry_rollup tool exposes verbose in inputSchema', () => {
  const tool = createShowTelemetryRollupTool({ db: null });
  assert.equal(tool.inputSchema.properties.verbose.type, 'boolean');
});
