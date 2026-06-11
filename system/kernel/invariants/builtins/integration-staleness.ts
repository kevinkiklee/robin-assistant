import type { RobinDb } from '../../../brain/memory/db.ts';
import type { Policies } from '../../config/schema.ts';
import type { Invariant } from '../types.ts';
import { cadenceMs } from './cadence.ts';

export interface ScheduledIntegration {
  name: string;
  cron: string;
}

const DEFAULT_WARN_MULTIPLIER = 3;
const DEFAULT_CRITICAL_MULTIPLIER = 10;

/**
 * Flags scheduled integrations that have gone stale — no successful tick in N×
 * their nominal cadence — or that are stuck in a skip streak (secrets missing,
 * OAuth revoked). This complements `integrations.healthy` (which fires on an
 * *error* streak): an integration can stop producing data without erroring —
 * by silently skipping, or by the scheduler simply never firing it.
 *
 * Power/network suppression: when the daemon is paused/off, or the network is
 * local-only/offline, ticks aren't running (or are expected to skip), so absent
 * freshness is not a fault. We return ok wholesale rather than reasoning per
 * integration. A post-resume grace of one cadence gives each integration its
 * first cycle to catch up before we judge it.
 *
 * `warning` severity: a stale source doesn't take the daemon down. Per-line
 * CRITICAL markers in the message let the alert wiring (Task 8) escalate the
 * worst offenders; invariant-level escalation is not this layer's job.
 */
export function integrationStalenessInvariant(
  db: RobinDb,
  opts: {
    /** Enabled, schedule-bearing integrations only. */
    integrations: () => ScheduledIntegration[];
    policies: () => Policies;
    now?: () => Date;
  },
): Invariant {
  const now = opts.now ?? (() => new Date());
  return {
    name: 'integrations.staleness',
    severity: 'warning',
    symptom:
      'A scheduled integration has produced no successful tick in many cadences, or is stuck skipping (e.g. missing secret / revoked OAuth).',
    cause:
      'last_ok_at is older than warn/critical × the integration cadence, or consecutive_skips >= 3. Common roots: scheduler not firing the tick, expired refresh token, or a missing secret causing every tick to skip.',
    fix: 'Run `robin doctor` to see which integrations and why; for OAuth-class skips re-grant with `robin reauth <name>`; for missing secrets add the key to user-data/config/secrets/.env and restart the daemon.',
    check: () => {
      try {
        const p = opts.policies();

        // Suppression: ticks aren't running (paused/off) or are expected to skip
        // (local-only/offline). Don't judge freshness we never gave a chance to refresh.
        if (p.power.state !== 'active' || p.network.mode !== 'online') {
          return { ok: true };
        }

        const nowMs = now().getTime();
        const resumedAt = p.power.since ? Date.parse(p.power.since) : 0;

        const stale: string[] = [];
        const critical: string[] = [];

        for (const { name, cron } of opts.integrations()) {
          const override = p.alerts.staleness[name];
          if (override?.exempt) continue;

          const cad = cadenceMs(cron);
          if (cad === null) continue; // unparseable schedule — nothing to anchor on

          // Post-resume grace: give the integration one full cadence after a
          // resume before judging it stale.
          if (Number.isFinite(resumedAt) && nowMs - resumedAt < cad) continue;

          const kv = readKv(db, name);

          // Never ticked: fresh install, nothing to judge yet.
          if (kv.last_attempt_at === undefined) continue;

          // Skip streak: 3+ back-to-back skips is its own unhealthy state,
          // independent of last_ok_at (which can be recent from before the streak).
          const skips = Number(kv.consecutive_skips ?? '0');
          if (skips >= 3) {
            const reason = kv.last_skip_reason ?? 'unknown reason';
            stale.push(`${name}: skipping (${reason})`);
            continue;
          }

          // Age since last successful tick.
          let age: number;
          if (kv.last_ok_at !== undefined) {
            age = nowMs - Date.parse(kv.last_ok_at);
          } else {
            // Transition heuristic (deployment transient): last_ok_at only began
            // being written at Task 3. Right after deploy, healthy integrations
            // have last_attempt_at but no last_ok_at yet — treating age as Infinity
            // would false-alarm every one of them. So when last_ok_at is absent we
            // fall back to last_attempt_at as a freshness proxy IF the integration
            // is erroring-free (consecutive_errors == 0). Only when it's actively
            // erroring with no recorded success do we treat age as Infinity (it
            // ticks but never succeeds — genuinely stale). This guard can be removed
            // once last_ok_at has been populated everywhere for a few cadences.
            const errs = Number(kv.consecutive_errors ?? '0');
            age = errs === 0 ? nowMs - Date.parse(kv.last_attempt_at) : Number.POSITIVE_INFINITY;
          }

          const warnAt = cad * (override?.warn_multiplier ?? DEFAULT_WARN_MULTIPLIER);
          const critAt = cad * (override?.critical_multiplier ?? DEFAULT_CRITICAL_MULTIPLIER);
          if (age > critAt) {
            critical.push(
              `${name}: stale ${fmtAge(age)} (>${DEFAULT_CRITICAL_MULTIPLIER}× cadence)`,
            );
          } else if (age > warnAt) {
            stale.push(`${name}: stale ${fmtAge(age)} (>${DEFAULT_WARN_MULTIPLIER}× cadence)`);
          }
        }

        if (critical.length === 0 && stale.length === 0) return { ok: true };
        return {
          ok: false,
          message: [...critical.map((s) => `CRITICAL ${s}`), ...stale].join('; '),
          remediation: 'robin doctor for detail; robin reauth <name> for OAuth-class skips',
        };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

type IntegrationKv = Partial<
  Record<
    | 'last_attempt_at'
    | 'last_ok_at'
    | 'consecutive_errors'
    | 'consecutive_skips'
    | 'last_skip_reason',
    string
  >
>;

function readKv(db: RobinDb, integration: string): IntegrationKv {
  const rows = db
    .prepare(`SELECT key, value FROM integration_state WHERE integration_name = ?`)
    .all(integration) as Array<{ key: string; value: string }>;
  const out: IntegrationKv = {};
  for (const { key, value } of rows) {
    if (
      key === 'last_attempt_at' ||
      key === 'last_ok_at' ||
      key === 'consecutive_errors' ||
      key === 'consecutive_skips' ||
      key === 'last_skip_reason'
    ) {
      out[key] = value;
    }
  }
  return out;
}

function fmtAge(ms: number): string {
  if (!Number.isFinite(ms)) return 'never';
  const h = ms / 3_600_000;
  if (h < 48) return `${Math.round(h)}h`;
  return `${Math.round(h / 24)}d`;
}
