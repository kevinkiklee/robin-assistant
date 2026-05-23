import type { LLMDispatcher } from '../../brain/llm/dispatcher.ts';
import type { RobinDb } from '../../brain/memory/db.ts';
import { buildContext } from '../../integrations/_runtime/context.ts';
import { createLogger } from '../../lib/logging/logger.ts';
import { resolveUserDataDir } from '../../lib/paths.ts';
import {
  daemonHeartbeatingInvariant,
  dbReachableInvariant,
  dbSchemaCurrentInvariant,
  integrationsHealthyInvariant,
  jobsDiscoverableInvariant,
  userDataWritableInvariant,
} from '../invariants/builtins/index.ts';
import { runInvariants } from '../invariants/runner.ts';

const CHECK_INTERVAL_MS = 60_000; // every minute
const NOTIFY_COOLDOWN_MS = 60 * 60_000; // 1 hour: don't spam the same failure
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

interface HealthMonitorOptions {
  db: RobinDb;
  getLLM: () => LLMDispatcher | null | undefined;
  getLastTickAt: () => Date | null;
  /** Pass a getter (re-evaluated per tick) when the value can change without a daemon restart
   *  (e.g. driven from policies.yaml). Boolean is also accepted for tests / static configs. */
  enableNotifications?: boolean | (() => boolean);
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

  private async tick(): Promise<void> {
    const userData = resolveUserDataDir();
    try {
      const reports = await runInvariants([
        userDataWritableInvariant(userData),
        dbReachableInvariant(this.opts.db),
        dbSchemaCurrentInvariant(this.opts.db),
        integrationsHealthyInvariant(this.opts.db),
        jobsDiscoverableInvariant(this.opts.db),
        daemonHeartbeatingInvariant({
          lastTickAt: this.opts.getLastTickAt,
          maxIntervalMs: 5 * 60_000,
        }),
      ]);

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
