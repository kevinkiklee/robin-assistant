// Reshape telemetry rollup data into per-faculty rows for the
// `show_telemetry_rollup` MCP tool. Hide zero-call faculties by default —
// quiet faculties are a frequent source of noise in agent-side rendering.
// Pass `verbose: true` to include them anyway (debugging or full-coverage
// audits).
//
// Input contract:
//   buckets: { [faculty]: { calls?, cost_usd?, avg_latency_ms?, errors? } }
//   verbose: boolean (default false) — include zero-call faculties
//
// Output contract:
//   [
//     { faculty, calls, cost_usd, avg_latency_ms, errors },
//     ...
//   ]
//
// Faculty order is fixed (matches the cognition-e1 umbrella ordering) so
// rendering is stable across calls. Faculties not in the canonical list are
// dropped — the canonical list is authoritative.

export const FACULTIES = [
  'biographer',
  'intuition',
  'dream',
  'reflection',
  'comm_style',
  'predictions',
  'introspection',
  'reinforcement',
  'belief',
  'dream_layer',
  'meta_cognition',
  'state_inference',
];

export function reshapeTelemetryRollup({ buckets, verbose = false } = {}) {
  const rows = [];
  for (const f of FACULTIES) {
    const bucket = buckets?.[f] ?? {};
    const calls = bucket.calls ?? 0;
    if (!verbose && calls === 0) continue;
    rows.push({
      faculty: f,
      calls,
      cost_usd: bucket.cost_usd ?? 0,
      avg_latency_ms: bucket.avg_latency_ms ?? null,
      errors: bucket.errors ?? 0,
    });
  }
  return rows;
}
