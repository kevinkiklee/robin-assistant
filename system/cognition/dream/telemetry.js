// telemetry.js — per-step writes into cadence_telemetry for dream's DAG.
// Spec §8 #1 and §5.1. Same field shape as cadence-consumer.js so
// currentBudget(db, cfg) sums dream and cadence consumption with no special
// case. C3 may rename or split this table; until then this is the home.

import { BoundQuery } from 'surrealdb';

/**
 * Layer lookup for dream_telemetry rows. Matches dag.js DREAM_DAG_DEPS
 * topological layering: knowledge/patterns/reflection/profile/arcs/commStyle
 * in layer 1; scopeCleanup/calibration in layer 2; compaction in layer 3.
 */
const STEP_LAYER = {
  knowledge: 1,
  patterns: 1,
  reflection: 1,
  profile: 1,
  arcs: 1,
  commStyle: 1,
  scopeCleanup: 2,
  calibration: 2,
  compaction: 3,
};

/**
 * @param {any} db
 * @param {string} name camelCase step name — one of the DREAM_DAG_DEPS keys
 * @param {number} ms wall-clock duration in milliseconds
 * @param {Error | null | undefined} [err]
 * @param {{ tokens_in?: number, tokens_out?: number, parallel?: boolean }} [usage]
 */
export async function recordStepTelemetry(db, name, ms, err, usage) {
  const tokens_in = usage?.tokens_in ?? 0;
  const tokens_out = usage?.tokens_out ?? 0;
  const parallel = !!usage?.parallel;
  const success = !err;
  const errorMsg = err instanceof Error ? err.message : err ? String(err) : null;

  // Additive: write a structured row to dream_telemetry (post-alpha.17
  // follow-up). cadence_telemetry continues to be written for back-compat
  // with currentBudget() and the C3 hot-bridge.
  try {
    await db
      .query(
        new BoundQuery(
          `CREATE dream_telemetry CONTENT {
             step: $step, layer: $layer,
             tokens_in: $tin, tokens_out: $tout,
             duration_ms: $dur, success: $ok, parallel: $par
             ${errorMsg !== null ? ', error: $err' : ''}
           }`,
          {
            step: String(name),
            layer: STEP_LAYER[name] ?? 0,
            tin: tokens_in,
            tout: tokens_out,
            dur: ms,
            ok: success,
            par: parallel,
            ...(errorMsg !== null ? { err: errorMsg } : {}),
          },
        ),
      )
      .collect();
  } catch {
    /* fail-soft */
  }

  try {
    if (errorMsg !== null) {
      await db
        .query(
          new BoundQuery(
            `CREATE cadence_telemetry CONTENT {
               step: $step, trigger_id: NONE,
               tokens_in: $tin, tokens_out: $tout,
               duration_ms: $dur, success: $ok, error: $err
             }`,
            {
              step: String(name),
              tin: tokens_in,
              tout: tokens_out,
              dur: ms,
              ok: success,
              err: errorMsg,
            },
          ),
        )
        .collect();
    } else {
      // Omit `error` field so SurrealDB's option<string> stays NONE
      // (it rejects an explicit NULL bound parameter).
      await db
        .query(
          new BoundQuery(
            `CREATE cadence_telemetry CONTENT {
               step: $step, trigger_id: NONE,
               tokens_in: $tin, tokens_out: $tout,
               duration_ms: $dur, success: $ok
             }`,
            {
              step: String(name),
              tin: tokens_in,
              tout: tokens_out,
              dur: ms,
              ok: success,
            },
          ),
        )
        .collect();
    }
  } catch {
    // Telemetry failures must never abort the dream run; swallow.
  }
}
