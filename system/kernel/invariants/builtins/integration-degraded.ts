import type { RobinDb } from '../../../brain/memory/db.ts';
import type { Invariant } from '../types.ts';

/**
 * Flags integrations where an individual data stream has failed on 3 or more
 * consecutive ticks while the top-level tick status was still 'ok' (partial
 * success). This catches scenarios like WHOOP's workout endpoint 503ing on
 * every tick while the other three streams succeed — the integration looks
 * healthy from a staleness/error perspective but one data stream is silently
 * missing. The counter is written by writeHeartbeat under the `degraded:*`
 * key prefix in integration_state and resets to '0' on any tick where the
 * stream succeeds.
 *
 * `warning` severity: a degraded stream doesn't take down an integration and
 * the daemon keeps running. The operator sees it via `robin doctor` or the
 * periodic health check notification.
 */
export function integrationDegradedInvariant(db: RobinDb): Invariant {
  return {
    name: 'integrations.streams_healthy',
    severity: 'warning',
    symptom:
      'One or more integration sub-streams are failing on every tick while the integration itself keeps ticking (e.g. WHOOP workout endpoint returns 503 repeatedly).',
    cause:
      "A `degraded:<stream>` counter in integration_state has reached 3+ consecutive ticks. The integration tick returns status='ok' overall (partial success) but one data stream is consistently rejected or timing out.",
    fix: 'Run `robin doctor` to identify which integration/stream pair is affected. Check the upstream API status for that endpoint. Re-authenticate if auth-scoped (`robin reauth <name>`). If the stream is temporarily unavailable, the counter resets automatically once it recovers.',
    check: () => {
      try {
        const rows = db
          .prepare(
            `SELECT integration_name, key, value FROM integration_state
              WHERE key LIKE 'degraded:%' AND CAST(value AS INTEGER) >= 3`,
          )
          .all() as Array<{ integration_name: string; key: string; value: string }>;
        if (rows.length === 0) return { ok: true };
        return {
          ok: false,
          message: rows
            .map(
              (r) =>
                `${r.integration_name}/${r.key.slice('degraded:'.length)} degraded ${r.value} consecutive ticks`,
            )
            .join('; '),
        };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
