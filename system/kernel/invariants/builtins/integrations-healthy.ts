import type { RobinDb } from '../../../brain/memory/db.ts';
import type { Invariant } from '../types.ts';

/**
 * Flags integrations that are silently broken: every recent tick has errored AND
 * consecutive_errors >= 5. Catches OAuth-expired, API-key-revoked, scheduler-stopped
 * scenarios that previously produced log noise but no operator-facing signal.
 *
 * Returns ok when no integrations are broken — even if some are merely silent or idle.
 * Those non-failing states are visible via `robin integrations` and don't warrant a
 * notification: a silent integration that genuinely has no new data is healthy.
 *
 * `warning` severity (not critical) — a broken integration doesn't take down the
 * daemon, just stops feeding one source. The health-monitor's critical-cooldown won't
 * trigger a macOS notification for warnings, which is intentional: notifying every
 * hour about Google Drive's stale OAuth would be obnoxious. The signal lives in
 * `robin doctor` and the integrations table, where the operator sees it on demand.
 */
export function integrationsHealthyInvariant(db: RobinDb): Invariant {
  return {
    name: 'integrations.healthy',
    severity: 'warning',
    symptom:
      'One or more integrations are erroring on every tick (e.g. expired OAuth, revoked API key).',
    cause:
      'consecutive_errors >= 5 for at least one integration in integration_state. Most common: a refresh token has been revoked by the upstream provider.',
    fix: 'Run `robin integrations` to see which ones, then re-grant the affected provider (e.g. re-run the OAuth flow, paste a new API key into user-data/config/secrets/.env, restart the daemon).',
    check: () => {
      try {
        const broken = db
          .prepare(
            `SELECT integration_name, CAST(value AS INTEGER) AS errs
               FROM integration_state
               WHERE key = 'consecutive_errors' AND CAST(value AS INTEGER) >= 5`,
          )
          .all() as Array<{ integration_name: string; errs: number }>;
        if (broken.length === 0) return { ok: true };
        const names = broken
          .map((r) => `${r.integration_name}(${r.errs})`)
          .sort()
          .join(', ');
        return {
          ok: false,
          message: `broken: ${names}`,
          remediation: 'see `robin integrations` for last_error per integration',
        };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
