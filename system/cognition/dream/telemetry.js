// telemetry.js — per-step writes into cadence_telemetry for dream's DAG.
// Spec §8 #1 and §5.1. Same field shape as cadence-consumer.js so
// currentBudget(db, cfg) sums dream and cadence consumption with no special
// case. C3 may rename or split this table; until then this is the home.

import { BoundQuery } from 'surrealdb';

/**
 * @param {any} db
 * @param {string} name camelCase step name — one of the DREAM_DAG_DEPS keys
 * @param {number} ms wall-clock duration in milliseconds
 * @param {Error | null | undefined} [err]
 * @param {{ tokens_in?: number, tokens_out?: number }} [usage]
 */
export async function recordStepTelemetry(db, name, ms, err, usage) {
  const tokens_in = usage?.tokens_in ?? 0;
  const tokens_out = usage?.tokens_out ?? 0;
  const success = !err;
  const errorMsg = err instanceof Error ? err.message : err ? String(err) : null;
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
