// Phase B.2 Task 12 — reshape telemetry rollup data into per-faculty rows for
// the `show_telemetry_rollup` MCP tool. Zero-call faculties are dropped by
// default and only included when verbose:true.

import assert from 'node:assert';
import test from 'node:test';
import { FACULTIES, reshapeTelemetryRollup } from '../../io/format/telemetry-rollup.js';

test('reshapeTelemetryRollup returns per-faculty rows', () => {
  const buckets = {
    biographer: { calls: 47, cost_usd: 0.12, avg_latency_ms: 230, errors: 1 },
    intuition: { calls: 12, cost_usd: 0.03 },
  };
  const r = reshapeTelemetryRollup({ buckets });
  assert.strictEqual(r.length, 2);
  assert.strictEqual(r[0].faculty, 'biographer');
  assert.strictEqual(r[0].calls, 47);
  assert.strictEqual(r[0].cost_usd, 0.12);
  assert.strictEqual(r[0].avg_latency_ms, 230);
  assert.strictEqual(r[0].errors, 1);
  assert.strictEqual(r[1].faculty, 'intuition');
  assert.strictEqual(r[1].calls, 12);
  // Missing avg_latency_ms / errors default to null / 0.
  assert.strictEqual(r[1].avg_latency_ms, null);
  assert.strictEqual(r[1].errors, 0);
});

test('reshapeTelemetryRollup hides zero-call faculties by default', () => {
  const buckets = { biographer: { calls: 47 }, intuition: { calls: 0 } };
  const r = reshapeTelemetryRollup({ buckets });
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].faculty, 'biographer');
});

test('reshapeTelemetryRollup includes zero-call faculties when verbose:true', () => {
  const buckets = { biographer: { calls: 47 }, intuition: { calls: 0 } };
  const r = reshapeTelemetryRollup({ buckets, verbose: true });
  // Verbose pulls in every canonical faculty, not just the two declared in
  // `buckets` — missing faculties materialize as zero-call rows.
  assert.strictEqual(r.length, FACULTIES.length);
  const byFaculty = Object.fromEntries(r.map((row) => [row.faculty, row]));
  assert.strictEqual(byFaculty.biographer.calls, 47);
  assert.strictEqual(byFaculty.intuition.calls, 0);
  assert.strictEqual(byFaculty.dream.calls, 0);
});

test('reshapeTelemetryRollup handles missing buckets argument', () => {
  // No buckets at all → no rows by default (every faculty is zero-call).
  assert.deepStrictEqual(reshapeTelemetryRollup({}), []);
  // Verbose with no buckets surfaces every faculty as zero.
  const verbose = reshapeTelemetryRollup({ verbose: true });
  assert.strictEqual(verbose.length, FACULTIES.length);
  for (const row of verbose) {
    assert.strictEqual(row.calls, 0);
    assert.strictEqual(row.errors, 0);
  }
});
