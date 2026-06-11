import { join } from 'node:path';
import type { LLMDispatcher } from '../../brain/llm/dispatcher.ts';
import type { RobinDb } from '../../brain/memory/db.ts';
import { buildContext } from '../../integrations/_runtime/context.ts';
import { createLogger } from '../../lib/logging/logger.ts';
import { resolveUserDataDir } from '../../lib/paths.ts';
import { loadPolicies } from '../config/load.ts';
import {
  daemonHeartbeatingInvariant,
  daemonStableInvariant,
  dbReachableInvariant,
  dbSchemaCurrentInvariant,
  integrationDegradedInvariant,
  integrationStalenessInvariant,
  integrationsHealthyInvariant,
  jobsDiscoverableInvariant,
  jobsErroringInvariant,
  type ScheduledIntegration,
  schedulerProgressingInvariant,
  userDataWritableInvariant,
} from '../invariants/builtins/index.ts';
import type { Invariant, InvariantReport } from '../invariants/types.ts';
import { recordAlert, resolveAlert } from './alert-store.ts';

const CHECK_INTERVAL_MS = 60_000; // every minute
const NOTIFY_COOLDOWN_MS = 60 * 60_000; // 1 hour: don't spam the same failure
// Per-check wall-clock cap. A check that blocks past this is itself a problem (a
// wedged DB query, a hung fs stat), so we abort it, report it as failed, AND
// record an alert — a chronically slow check is a real signal, not noise.
const DEFAULT_CHECK_TIMEOUT_MS = 5_000;
// Bug A fix — wait this long after daemon start before allowing heartbeat-triggered
// self-termination. Boot is noisy (migrations, integration init, biographer
// boot-drain); a CRITICAL during that window is almost always a false positive,
// not a runtime wedge.
const HEARTBEAT_RECOVER_MIN_UPTIME_MS = 2 * 60_000;
// Bug A fix part 2 — only escalate to self-termination after the heartbeat has been
// continuously CRITICAL for this long. A single CRITICAL observation can be a slow
// handler (biographer processing a large session can legitimately run 30+ min before
// the runLoop's `await tickOnce()` returns). The original incident on 2026-05-21
// had heartbeat CRITICAL for 3+ hours — well beyond any legitimate handler.
// Threshold sized to be longer than any plausible handler runtime but shorter than
// the multi-hour wedges we want to recover from.
const HEARTBEAT_SUSTAINED_CRITICAL_MS = 30 * 60_000;

// Sentinel set on reports produced by the overlap guard (a check whose previous
// run hadn't finished). These reports say NOTHING about the underlying condition,
// so the alert wiring neither records nor resolves on them.
const OVERLAP_SKIP = Symbol('overlap-skip');
type MonitorReport = InvariantReport & { [OVERLAP_SKIP]?: true };

interface HealthMonitorOptions {
  db: RobinDb;
  getLLM: () => LLMDispatcher | null | undefined;
  getLastTickAt: () => Date | null;
  /** Pass a getter (re-evaluated per tick) when the value can change without a daemon restart
   *  (e.g. driven from policies.yaml). Boolean is also accepted for tests / static configs. */
  enableNotifications?: boolean | (() => boolean);
  /** Enabled, schedule-bearing integrations (instance name + cron) for the
   *  integration-staleness invariant. Re-evaluated per tick so hot-reloaded
   *  integrations are picked up without a restart. Absent ⇒ no integrations to judge. */
  getIntegrations?: () => ScheduledIntegration[];
  /** Per-check timeout in ms. Default 5000. Lowered in tests to keep them fast. */
  checkTimeoutMs?: number;
  /** Bug A fix — invoked when `daemon.heartbeating` goes CRITICAL after the daemon
   *  has been alive for at least `HEARTBEAT_RECOVER_MIN_UPTIME_MS`. Production wires
   *  this to `process.exit(1)` so launchd respawns the daemon cleanly, which restores
   *  the broken scheduler loop. Fires at most once per daemon lifetime. Caller is
   *  expected to terminate the process. */
  onHeartbeatCritical?: () => void;
  /** When the daemon started, used to gate `onHeartbeatCritical` so boot-time false
   *  positives don't trigger a restart loop. */
  getStartedAt?: () => number;
}

export class HealthMonitor {
  private timer: NodeJS.Timeout | null = null;
  private log = createLogger({ module: 'health-monitor' });
  private lastNotifiedAt = new Map<string, number>(); // invariant name → ts
  private heartbeatRecoveryFired = false;
  // Invariant names whose previous check run is still in flight. A check whose
  // name is already here is overlap-skipped (not re-run) this tick.
  private inFlight = new Set<string>();
  // First time we observed `daemon.heartbeating` in CRITICAL state. Reset to null
  // whenever a tick passes and the heartbeat is healthy again. Used to enforce the
  // sustained-CRITICAL gate on Bug A recovery so a normal slow handler doesn't
  // trigger an infinite restart loop.
  private firstHeartbeatCriticalAt: number | null = null;

  constructor(private opts: HealthMonitorOptions) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, CHECK_INTERVAL_MS);
    // unref so this timer doesn't prevent process exit
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Build the invariant set checked each tick. Kept as a method so providers
   *  (integrations list, policies) are re-evaluated per tick. */
  private buildInvariants(userData: string): Invariant[] {
    const bootsPath = join(userData, 'state', 'runtime', 'boots.json');
    return [
      userDataWritableInvariant(userData),
      dbReachableInvariant(this.opts.db),
      dbSchemaCurrentInvariant(this.opts.db),
      integrationsHealthyInvariant(this.opts.db),
      integrationStalenessInvariant(this.opts.db, {
        integrations: () => this.opts.getIntegrations?.() ?? [],
        policies: () => loadPolicies(userData),
      }),
      integrationDegradedInvariant(this.opts.db),
      jobsDiscoverableInvariant(this.opts.db),
      jobsErroringInvariant(this.opts.db),
      daemonStableInvariant({ bootsPath }),
      // Critical so it notifies (warnings don't): catches the paused/stalled
      // scheduler that daemon.heartbeating structurally can't see — its lastTickAt
      // updates every loop iteration even while paused.
      schedulerProgressingInvariant(this.opts.db, { userData }),
      daemonHeartbeatingInvariant({
        lastTickAt: this.opts.getLastTickAt,
        // 7 min: the claude-agent provider (subscription-billed via the Agent
        // SDK) boots the full Claude Code runtime per call, adding ~20-40s of
        // subprocess overhead vs a direct REST provider. A 5-min ceiling trips
        // on normal biographer ticks (~5:20). 7 min gives headroom without
        // hiding a genuinely stuck scheduler. Permanent now that reasoning is
        // Claude-only (the 2026-06-15 Gemini cutback was cancelled 2026-06-10).
        maxIntervalMs: 7 * 60_000,
      }),
    ];
  }

  /**
   * Run one invariant's check with an overlap guard + wall-clock timeout.
   *   - Overlap: if the previous run of this check hasn't finished, skip it
   *     entirely this tick and return an OVERLAP_SKIP-tagged report (the alert
   *     wiring ignores these — they say nothing about the condition).
   *   - Timeout: a check exceeding `checkTimeoutMs` is aborted and reported as
   *     'check timed out'. That DOES record an alert: a chronically slow check is
   *     itself a problem worth surfacing.
   *   - A thrown check becomes a failing report (message preserved).
   */
  private async runOne(inv: Invariant, timeoutMs: number): Promise<MonitorReport> {
    if (this.inFlight.has(inv.name)) {
      return {
        name: inv.name,
        severity: inv.severity,
        ok: false,
        message: 'previous check still running',
        duration_ms: 0,
        [OVERLAP_SKIP]: true,
      };
    }
    this.inFlight.add(inv.name);
    const start = performance.now();

    // p is the original check promise.  We drive inFlight from p's own
    // settlement so that a timed-out check (where the timeout wins the race
    // below) stays in flight until the underlying async work actually finishes.
    // Without this, deleting from inFlight when the timeout fires would let the
    // very next tick re-run a check that is still pending — the exact overlap
    // pile-up the guard is meant to prevent.
    const p = Promise.resolve(inv.check());
    // Swallow p's rejection here so it never becomes an unhandled rejection;
    // the race path below already captures and reports any error.
    p.then(undefined, () => {}).finally(() => this.inFlight.delete(inv.name));

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('check timed out')), timeoutMs);
      timer.unref?.();
    });
    try {
      const r = await Promise.race([p, timeout]);
      return {
        name: inv.name,
        severity: inv.severity,
        ok: r.ok,
        message: r.message,
        remediation: r.remediation,
        duration_ms: Math.round(performance.now() - start),
      };
    } catch (err) {
      return {
        name: inv.name,
        severity: inv.severity,
        ok: false,
        message: err instanceof Error ? err.message : String(err),
        duration_ms: Math.round(performance.now() - start),
      };
    } finally {
      // Clear the timeout timer here (race is done).  Do NOT touch inFlight —
      // that is owned by p's finally above so timed-out checks stay guarded.
      if (timer) clearTimeout(timer);
    }
  }

  private async tick(): Promise<void> {
    const userData = resolveUserDataDir();
    const timeoutMs = this.opts.checkTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
    try {
      const invariants = this.buildInvariants(userData);
      const reports: MonitorReport[] = [];
      for (const inv of invariants) {
        reports.push(await this.runOne(inv, timeoutMs));
      }

      // Generic alert wiring: every report opens or resolves an alert keyed by
      // (source='invariant', key=report.name). Overlap-skip reports are excluded —
      // they carry no signal about the underlying condition. Each alert-store call
      // is wrapped: alerting must never break the monitor tick (a dropped alerts
      // table, a locked DB) — a failed write just logs a warning.
      for (const r of reports) {
        if (r[OVERLAP_SKIP]) continue;
        try {
          if (r.ok) {
            resolveAlert(this.opts.db, 'invariant', r.name);
          } else {
            recordAlert(this.opts.db, {
              severity: r.severity === 'critical' ? 'critical' : 'warning',
              source: 'invariant',
              key: r.name,
              message: r.message ?? 'invariant failed',
            });
          }
        } catch (err) {
          this.log.warn({ err, name: r.name }, 'alert record/resolve failed');
        }
      }

      // Bug A fix part 2 — maintain sustained-CRITICAL state and evaluate recovery
      // OUTSIDE the cooldown-gated notification loop below. The cooldown is purely a
      // log-spam mitigation; recovery is a separate concern and must be checked every
      // tick. Combining them caused recovery to fail on the second tick after the
      // first CRITICAL set the cooldown.
      const heartbeatReport = reports.find((r) => r.name === 'daemon.heartbeating');
      if (heartbeatReport) {
        const isCritical = !heartbeatReport.ok && heartbeatReport.severity === 'critical';
        if (isCritical) {
          if (this.firstHeartbeatCriticalAt === null) {
            this.firstHeartbeatCriticalAt = Date.now();
          }
          this.maybeEscalateHeartbeat();
        } else {
          // Heartbeat recovered on its own — clear so the next CRITICAL run starts fresh.
          this.firstHeartbeatCriticalAt = null;
        }
      }

      for (const r of reports) {
        if (r.ok) continue;
        if (r.severity !== 'critical') continue;
        const last = this.lastNotifiedAt.get(r.name) ?? 0;
        if (Date.now() - last < NOTIFY_COOLDOWN_MS) continue; // cooldown
        this.lastNotifiedAt.set(r.name, Date.now());
        this.log.error({ name: r.name, message: r.message }, 'invariant CRITICAL');

        const notifyOn =
          typeof this.opts.enableNotifications === 'function'
            ? this.opts.enableNotifications()
            : !!this.opts.enableNotifications;
        if (notifyOn) {
          try {
            const llm = this.opts.getLLM() ?? null;
            // Future: use ctx for richer integrations; for now, just call notifyMacOSAction
            buildContext('notify', this.opts.db, llm);
            const { notifyMacOSAction } = await import(
              '../../integrations/builtin/notify/index.ts'
            );
            await notifyMacOSAction({
              title: `Robin: ${r.name}`,
              message: r.message ?? 'critical invariant failed',
            });
          } catch (err) {
            this.log.warn({ err }, 'failed to send health notification');
          }
        }
      }
    } catch (err) {
      this.log.warn({ err }, 'health monitor tick threw');
    }
  }

  /**
   * Bug A fix — escalate to self-termination when the heartbeat has been continuously
   * CRITICAL long enough that no legitimate handler runtime explains it. Called from
   * the tick body whenever the heartbeat is CRITICAL, independent of the log cooldown.
   * Other CRITICAL invariants (db.reachable, schema_current, userData.writable) get
   * logged + notified but not restart-escalated because a process restart wouldn't
   * fix them. Heartbeat is the one CRITICAL where launchd respawning is the right
   * answer: the scheduler is stuck inside an awaited handler call, and no in-process
   * action can unstick it.
   */
  private maybeEscalateHeartbeat(): void {
    if (this.heartbeatRecoveryFired) return;
    if (!this.opts.onHeartbeatCritical) return;

    const startedAt = this.opts.getStartedAt?.() ?? 0;
    const uptime = startedAt ? Date.now() - startedAt : Number.POSITIVE_INFINITY;
    const sustainedMs =
      this.firstHeartbeatCriticalAt === null ? 0 : Date.now() - this.firstHeartbeatCriticalAt;

    if (uptime < HEARTBEAT_RECOVER_MIN_UPTIME_MS) {
      this.log.warn(
        { uptime_ms: uptime, min_uptime_ms: HEARTBEAT_RECOVER_MIN_UPTIME_MS },
        'daemon.heartbeating CRITICAL during boot — recovery suppressed',
      );
      return;
    }
    if (sustainedMs < HEARTBEAT_SUSTAINED_CRITICAL_MS) {
      this.log.warn(
        { sustained_critical_ms: sustainedMs, required_ms: HEARTBEAT_SUSTAINED_CRITICAL_MS },
        'daemon.heartbeating CRITICAL but not yet sustained — recovery deferred',
      );
      return;
    }

    this.heartbeatRecoveryFired = true;
    this.log.error(
      { uptime_ms: uptime, sustained_critical_ms: sustainedMs },
      'daemon.heartbeating CRITICAL sustained — escalating: terminating for launchd respawn',
    );
    try {
      this.opts.onHeartbeatCritical();
    } catch (err) {
      this.log.error({ err }, 'onHeartbeatCritical threw');
    }
  }
}
