// recorder.js — recordTelemetry({faculty, event_kind, ts?, dimensions?, metrics?, meta?})
//
// Contract (spec §3.1 / §3.4 / §3.5):
//   - dimensions values: string | bool | int (NO floats, NO nested objects,
//     NO arrays). Strings must match /^[A-Za-z0-9_.-]{1,64}$/.
//   - metrics values: scalar numbers OR object<string, number> with ≤16
//     keys; object values are fanned out into `<key>_<subkey>` scalars at
//     write time.
//   - meta is FLEXIBLE per-row extras; free text goes here, NOT in
//     dimensions. The recorder does NOT auto-move; the caller is
//     responsible.
//
// The recorder is a write-only API; rollup SELECTs read from per-faculty
// raw tables (intuition_telemetry, recall_log, cadence_telemetry,
// meta_cognition_telemetry). Future faculties adopting the umbrella raw
// shape get a single `telemetry_raw_<faculty>` table — out of scope for
// C3 (no schema migration shipped for the raw family in this round).

const DIM_CHARSET = /^[A-Za-z0-9_.-]+$/;
const DIM_MAX_LEN = 64;
const METRIC_OBJECT_MAX_KEYS = 16;

function validateDimensions(dimensions) {
  if (dimensions == null) return;
  if (typeof dimensions !== 'object' || Array.isArray(dimensions)) {
    throw new Error('dimensions must be a plain object');
  }
  for (const [k, v] of Object.entries(dimensions)) {
    if (v === null || v === undefined) continue; // null grouping bucket is allowed
    const t = typeof v;
    if (t === 'boolean') continue;
    if (t === 'number') {
      if (!Number.isInteger(v)) {
        throw new Error(`dimension value type: ${k} is float (only string|bool|int allowed)`);
      }
      continue;
    }
    if (t !== 'string') {
      throw new Error(`dimension value type: ${k} is ${t} (only string|bool|int allowed)`);
    }
    if (v.length > DIM_MAX_LEN) {
      throw new Error(`dimension value exceeds 64 chars: ${k}`);
    }
    if (!DIM_CHARSET.test(v)) {
      throw new Error(
        `dimension value charset: ${k}=${JSON.stringify(v)} (only [A-Za-z0-9_.-] allowed)`,
      );
    }
  }
}

function fanOutMetrics(metrics) {
  if (metrics == null) return {};
  if (typeof metrics !== 'object' || Array.isArray(metrics)) {
    throw new Error('metrics must be a plain object');
  }
  const out = {};
  for (const [k, v] of Object.entries(metrics)) {
    if (v == null) continue;
    if (typeof v === 'number') {
      out[k] = v;
      continue;
    }
    if (typeof v === 'object' && !Array.isArray(v)) {
      const subKeys = Object.keys(v);
      if (subKeys.length > METRIC_OBJECT_MAX_KEYS) {
        throw new Error(`object-shaped metric exceeds 16 keys: ${k} (${subKeys.length})`);
      }
      // Strip the trailing `_by_<scope>` from the parent key if present, so
      // `contradictions_suppressed_by_rule.low_confidence` becomes
      // `contradictions_suppressed_low_confidence` (spec §3.4 example).
      const prefix = k.replace(/_by_[a-z]+$/, '');
      for (const sk of subKeys) {
        const sv = v[sk];
        if (typeof sv !== 'number') {
          throw new Error(`object-shaped metric ${k}.${sk} is non-numeric`);
        }
        out[`${prefix}_${sk}`] = sv;
      }
      continue;
    }
    throw new Error(
      `metric value type: ${k} is ${typeof v} (number or object<string,number> only)`,
    );
  }
  return out;
}

/**
 * Record one telemetry event. Pure write; no rollup.
 *
 * @param {object} args
 * @param {object} args.db                 SurrealDB handle (or stub).
 * @param {string} args.faculty            e.g. 'intuition' | 'reinforcement' | …
 * @param {string} args.event_kind         e.g. 'recall' | 'evaluate' | …
 * @param {Date}   [args.ts]               Defaults to now.
 * @param {object} [args.dimensions]       §3.1-conformant.
 * @param {object} [args.metrics]          §3.4 — scalar or ≤16-key object.
 * @param {object} [args.meta]             FLEXIBLE per-row extras (free text OK).
 * @param {string} [args.targetTable]      Optional override; defaults to
 *   `telemetry_raw_${faculty}` for the umbrella table family.
 */
export async function recordTelemetry(args) {
  const { db, faculty, event_kind, ts, dimensions, metrics, meta, targetTable } = args;
  if (typeof faculty !== 'string' || !faculty.length) throw new Error('faculty required');
  if (typeof event_kind !== 'string' || !event_kind.length) throw new Error('event_kind required');
  validateDimensions(dimensions);
  const fannedMetrics = fanOutMetrics(metrics);
  const table = targetTable ?? `telemetry_raw_${faculty}`;
  const payload = {
    ts: ts ?? new Date(),
    faculty,
    event_kind,
    dimensions: dimensions ?? {},
    metrics: fannedMetrics,
    meta: meta ?? null,
  };
  return await db.query(`CREATE ${table} CONTENT $payload`, payload).collect();
}
