import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { LLMDispatcher } from '../../brain/llm/dispatcher.ts';
import type { RobinDb } from '../../brain/memory/db.ts';
import { buildContext } from '../../integrations/_runtime/context.ts';
import { createLogger } from '../../lib/logging/logger.ts';
import { resolveUserDataDir } from '../../lib/paths.ts';
import { loadPolicies } from '../config/load.ts';
import {
  captureVolumeSaneInvariant,
  daemonHeartbeatingInvariant,
  daemonStableInvariant,
  dbReachableInvariant,
  dbSchemaCurrentInvariant,
  integrationDegradedInvariant,
  integrationStalenessInvariant,
  integrationsHealthyInvariant,
  integrationUnreachableInvariant,
  jobsDiscoverableInvariant,
  jobsErroringInvariant,
  type ScheduledIntegration,
  schedulerProgressingInvariant,
  userDataWritableInvariant,
} from '../invariants/builtins/index.ts';
import type { Invariant, InvariantReport } from '../invariants/types.ts';
import {
  getOpenAlert,
  markEscalated,
  markRepairAttempted,
  recordAlert,
  recordDeferredObservation,
  resolveAlert,
  setOutcome,
} from './alert-store.ts';
import { hostSleptSince } from './host-sleep.ts';
import { currentSha, isRepairBroken, recordRepairFailure } from './repair-breaker.ts';

const CHECK_INTERVAL_MS = 60_000; // every minute
/** Wall-clock time that elapsed beyond monotonic time between two ticks. More
 *  than one interval of it means the host slept — where the monotonic clock
 *  stops in sleep (Linux). On macOS under Node 24 it does NOT stop (see
 *  host-sleep.ts), so a long wall gap is confirmed with the kernel instead. */
const SLEEP_GAP_MS = CHECK_INTERVAL_MS;
/** A wall gap between ticks this long is either a sleep or a blocked loop —
 *  worth one sysctl probe to tell which. */
const PROBE_GAP_MS = 2 * CHECK_INTERVAL_MS;
/** After a wake the scheduler's last tick is stale by the whole sleep until it
 *  ticks again — hold the heartbeat verdict until it has had time to. */
const POST_WAKE_GRACE_MS = 10 * 60_000;
const NOTIFY_COOLDOWN_MS = 60 * 60_000; // 1 hour: don't spam the same failure
// dependsOn deferral (spec: cause/symptom deferral) — a stuck parent cannot hide
// a child forever; after this much continuous deferral the child opens anyway.
const DEFER_CAP_MS = 6 * 3_600_000;
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
// Incident ladder (spec B): once a repair has been attempted and the invariant
// is still failing after this many observed failing ticks, escalate the
// incident (agentic remediation path picks it up from `escalated_at`).
const ESCALATE_AFTER_TICKS = 10;
// Escalated and still open this long with no outcome yet → nothing automated
// is closing it out, so stamp 'needs-human' rather than staying silently stuck.
const NEEDS_HUMAN_AFTER_MS = 24 * 3_600_000;

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
  /** Clocks for sleep detection (tests inject both). */
  clock?: { wall: () => number; mono: () => number };
  /** Epoch ms of the host's latest sleep/wake, or null (tests inject). */
  sleepProbe?: () => number | null;
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
  // dependsOn deferral (spec: cause/symptom deferral). name → epoch ms when
  // continuous deferral began. Cleared when the child passes or opens its own.
  private deferredSince = new Map<string, number>();
  // One-time dependsOn registry validation runs on the first tick only — a typo
  // fails loudly at boot, then is ignored (visible-and-inert) thereafter.
  private dependsOnValidated = false;
  // Incident ladder (spec B). name → consecutive observed-failing tick count
  // for the currently-open incident. Cleared whenever the invariant passes
  // (fresh incident next time it fails starts the count over).
  private failingTicks = new Map<string, number>();
  // Host sleep/wake detection. A sleeping Mac suspends the scheduler AND this
  // monitor, so on wake the heartbeat reads "silent for the whole nap" and, being
  // measured in wall-clock time, also reads as sustained — the daemon then killed
  // itself after every clamshell nap on battery (9/26, 9/30). Nothing was wedged.
  private lastWall: number | null = null;
  private lastMono: number | null = null;
  private wokeAt: number | null = null;

  constructor(private opts: HealthMonitorOptions) {}

  /** Record this tick's clocks; returns true when a host sleep ended since the last tick. */
  private noteSleep(): boolean {
    const wall = this.opts.clock?.wall() ?? Date.now();
    const mono = this.opts.clock?.mono() ?? performance.now();
    let slept = false;
    if (this.lastWall !== null && this.lastMono !== null) {
      const gap = wall - this.lastWall;
      const drift = gap - (mono - this.lastMono);
      if (
        drift > SLEEP_GAP_MS ||
        (gap > PROBE_GAP_MS && hostSleptSince(this.lastWall, this.opts.sleepProbe))
      ) {
        slept = true;
        this.wokeAt = wall;
        this.firstHeartbeatCriticalAt = null;
        this.log.info(
          { gap_ms: Math.round(gap), drift_ms: Math.round(drift) },
          'host sleep detected — heartbeat verdict held',
        );
      }
    }
    this.lastWall = wall;
    this.lastMono = mono;
    return slept;
  }

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
      // Ordering constraint: parents before dependents. A `dependsOn` deferral
      // records its observation on the parent's alert row, which only exists once
      // the parent's own report has opened it earlier in this same tick (reports
      // are produced — and the alert-wiring loop in `tick()` processes them — in
      // `buildInvariants` order). daemonStableInvariant and
      // daemonHeartbeatingInvariant must therefore be built (and thus checked)
      // before integrationStalenessInvariant and jobsErroringInvariant, which both
      // `dependsOn: ['daemon.stable', 'daemon.heartbeating']` — otherwise a first
      // deferring tick would find no open parent row yet and the deferral would
      // silently no-op.
      daemonStableInvariant({ bootsPath }),
      // Critical so it notifies (warnings don't): catches the paused/stalled
      // scheduler that daemon.heartbeating structurally can't see — its lastTickAt
      // updates every loop iteration even while paused.
      schedulerProgressingInvariant(this.opts.db, { userData }),
      daemonHeartbeatingInvariant({
        lastTickAt: this.opts.getLastTickAt,
        // Measure silence from the wake, not from before the nap: the
        // scheduler can't tick while the host sleeps. Re-check for sleep here,
        // not only at tick start: the checks are awaited one by one, and a nap
        // that lands mid-tick otherwise reaches this verdict unrecorded. On
        // 10/30 03:46Z that raised a CRITICAL 5 ms before the next tick logged
        // the wake. noteSleep only probes the kernel when the gap is >2 min.
        lastWakeAt: () => {
          this.noteSleep();
          return this.wokeAt;
        },
        // 7 min: the claude-agent provider (subscription-billed via the Agent
        // SDK) boots the full Claude Code runtime per call, adding ~20-40s of
        // subprocess overhead vs a direct REST provider. A 5-min ceiling trips
        // on normal biographer ticks (~5:20). 7 min gives headroom without
        // hiding a genuinely stuck scheduler. Permanent now that reasoning is
        // Claude-only (the 2026-06-15 Gemini cutback was cancelled 2026-06-10).
        maxIntervalMs: 7 * 60_000,
      }),
      integrationStalenessInvariant(this.opts.db, {
        integrations: () => this.opts.getIntegrations?.() ?? [],
        policies: () => loadPolicies(userData),
        bootsPath,
        llm: this.opts.getLLM,
      }),
      // Network-class failures (offline, DNS, fetch failed) surface here instead of as
      // staleness — no repair step, so the alert ladder never escalates them to an agent.
      integrationUnreachableInvariant(this.opts.db, {
        integrations: () => this.opts.getIntegrations?.() ?? [],
        policies: () => loadPolicies(userData),
        bootsPath,
      }),
      integrationDegradedInvariant(this.opts.db),
      jobsDiscoverableInvariant(this.opts.db),
      jobsErroringInvariant(this.opts.db),
      captureVolumeSaneInvariant(this.opts.db),
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
    //
    // Guard the promise creation itself: if check() throws synchronously (before
    // returning a promise), we must still clean up inFlight — otherwise the name
    // stays in the set permanently and the invariant is overlap-skipped forever.
    let p: Promise<{ ok: boolean; message?: string; remediation?: string }>;
    try {
      p = Promise.resolve(inv.check());
    } catch (err) {
      this.inFlight.delete(inv.name);
      return {
        name: inv.name,
        severity: inv.severity,
        ok: false,
        message: err instanceof Error ? err.message : String(err),
        duration_ms: Math.round(performance.now() - start),
      };
    }
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
    this.noteSleep();
    const userData = resolveUserDataDir();
    const timeoutMs = this.opts.checkTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
    try {
      const invariants = this.buildInvariants(userData);
      const reports: MonitorReport[] = [];
      for (const inv of invariants) {
        reports.push(await this.runOne(inv, timeoutMs));
      }

      // One-time dependsOn registry validation (spec: typo fails loudly at boot,
      // then is ignored — visible-and-inert). Validation/alerting failures must
      // never break the tick.
      const namesInSet = new Set(invariants.map((i) => i.name));
      if (!this.dependsOnValidated) {
        this.dependsOnValidated = true;
        for (const inv of invariants) {
          for (const parent of inv.dependsOn ?? []) {
            if (!namesInSet.has(parent)) {
              this.log.error(
                { invariant: inv.name, parent },
                'dependsOn references unknown invariant',
              );
              try {
                recordAlert(this.opts.db, {
                  severity: 'warning',
                  source: 'invariant',
                  key: 'registry.invalid-depends-on',
                  message: `${inv.name} dependsOn unknown invariant '${parent}'`,
                });
              } catch (err) {
                this.log.warn({ err }, 'failed to record registry.invalid-depends-on alert');
              }
            }
          }
        }
      }

      const byName = new Map(invariants.map((i) => [i.name, i]));
      const failedThisTick = new Set(
        reports.filter((r) => !r.ok && !r[OVERLAP_SKIP]).map((r) => r.name),
      );
      // Read the build SHA once per tick (not once per failing invariant) — the
      // breaker's SHA-keying only needs a consistent value across this tick's
      // ladder decisions, and re-reading dist/.build-stamp per invariant would
      // be wasted I/O.
      const sha = currentSha();

      // Generic alert wiring: every report opens or resolves an alert keyed by
      // (source='invariant', key=report.name). Overlap-skip reports are excluded —
      // they carry no signal about the underlying condition. Each alert-store call
      // is wrapped: alerting must never break the monitor tick (a dropped alerts
      // table, a locked DB) — a failed write just logs a warning.
      //
      // dependsOn deferral: a failing dependent whose parent is also failing this
      // tick records a deferred observation on the parent's alert instead of
      // opening its own — until DEFER_CAP_MS of continuous deferral, after which
      // it opens normally. This keeps a downstream symptom (e.g. integration
      // staleness while the daemon itself is down) from paging separately from
      // its root cause.
      for (const r of reports) {
        if (r[OVERLAP_SKIP]) continue;
        try {
          if (r.ok) {
            this.deferredSince.delete(r.name);
            this.failingTicks.delete(r.name);
            resolveAlert(this.opts.db, 'invariant', r.name);
          } else {
            const inv = byName.get(r.name);
            const failingParents = (inv?.dependsOn ?? []).filter(
              (p) => namesInSet.has(p) && failedThisTick.has(p),
            );
            const since = this.deferredSince.get(r.name);
            const capExceeded = since !== undefined && Date.now() - since > DEFER_CAP_MS;
            if (failingParents.length > 0) {
              if (!capExceeded) {
                if (since === undefined) this.deferredSince.set(r.name, Date.now());
                for (const parent of failingParents) {
                  recordDeferredObservation(
                    this.opts.db,
                    'invariant',
                    parent,
                    r.name,
                    r.message ?? 'failing (deferred)',
                  );
                }
                continue; // deferred: no own alert while the parent explains it
              }
              // Cap exceeded: graduate to a standalone alert. Deliberately KEEP
              // deferredSince here (do NOT delete) — the parent is still failing,
              // so clearing it would let the next tick see `since === undefined`,
              // re-defer, and flap the child's alert open/stale every cycle
              // instead of leaving it continuously open post-cap.
            } else {
              this.deferredSince.delete(r.name); // parent recovered — true reset
            }
            recordAlert(this.opts.db, {
              severity: r.severity === 'critical' ? 'critical' : 'warning',
              source: 'invariant',
              key: r.name,
              message: r.message ?? 'invariant failed',
            });

            // Incident ladder (spec B): deterministic repair once per incident,
            // escalate once after ESCALATE_AFTER_TICKS still-failing ticks, then
            // 'needs-human' after 24h escalated-and-open. Runs only here — AFTER
            // the deferral decision above (a deferred child `continue`d already
            // and never reaches this point) — and the atomic guarded UPDATE in
            // markRepairAttempted/markEscalated (not this in-memory state) is
            // what actually enforces "at most once per incident".
            const inv2 = byName.get(r.name);
            if (inv2?.repair) {
              if (isRepairBroken(userData, r.name, sha)) {
                // A broken breaker must not stall the incident at rung 0 forever
                // — claim the once-per-incident repair attempt anyway (so
                // escalation can still proceed on schedule) but skip the actual
                // repair() call that keeps failing.
                if (markRepairAttempted(this.opts.db, 'invariant', r.name)) {
                  this.log.warn(
                    { name: r.name },
                    'repair circuit-broken — skipping to escalation path',
                  );
                }
              } else if (markRepairAttempted(this.opts.db, 'invariant', r.name)) {
                // Separate try/catch scopes for repair() vs. the post-repair
                // re-check: only repair() throwing should notch the breaker. A
                // throwing re-check is a distinct failure (the repair may well
                // have worked) and must not be blamed on the repair itself.
                let repaired = false;
                try {
                  await inv2.repair();
                  repaired = true;
                } catch (err) {
                  recordRepairFailure(userData, r.name, sha);
                  this.log.warn({ err, name: r.name }, 'repair threw — repair breaker notched');
                }
                if (repaired) {
                  try {
                    const re = await Promise.resolve(inv2.check());
                    if (re.ok) {
                      resolveAlert(this.opts.db, 'invariant', r.name);
                      // Incident closed within THIS tick (in-tick repair fixed it) —
                      // clear the failing-tick counter here too, not just in the
                      // r.ok branch above. Without this, a rapid flap (fail →
                      // repair-fixes-in-tick → fail → repair-fixes-in-tick → …)
                      // would silently accumulate failingTicks across many
                      // different, already-closed incidents, and a later
                      // unrelated fresh incident would inherit that count and
                      // escalate on its very first failing tick.
                      this.failingTicks.delete(r.name);
                    }
                  } catch (err) {
                    this.log.warn(
                      { err, name: r.name },
                      'post-repair re-check threw — breaker not notched (only repair() failures count)',
                    );
                  }
                }
              }
            }
            this.failingTicks.set(r.name, (this.failingTicks.get(r.name) ?? 0) + 1);
            const ladderRow = getOpenAlert(this.opts.db, 'invariant', r.name);
            if (
              ladderRow?.repair_attempted_at &&
              !ladderRow.escalated_at &&
              (this.failingTicks.get(r.name) ?? 0) >= ESCALATE_AFTER_TICKS
            ) {
              markEscalated(this.opts.db, 'invariant', r.name);
              this.log.warn({ name: r.name }, 'incident escalated to agentic remediation');
            }
            if (
              ladderRow?.escalated_at &&
              !ladderRow.outcome &&
              // escalated_at is SQLite's datetime('now') — UTC, but formatted
              // without a timezone marker ('YYYY-MM-DD HH:MM:SS'). Date.parse
              // treats an unmarked date-time string as LOCAL time, which would
              // skew this comparison by the host's UTC offset. Normalize to an
              // explicit UTC ISO string before parsing.
              Date.now() - Date.parse(`${ladderRow.escalated_at.replace(' ', 'T')}Z`) >
                NEEDS_HUMAN_AFTER_MS
            ) {
              setOutcome(this.opts.db, 'invariant', r.name, 'needs-human');
            }
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
        const now = this.opts.clock?.wall() ?? Date.now();
        const justWoke = this.wokeAt !== null && now - this.wokeAt < POST_WAKE_GRACE_MS;
        if (isCritical && justWoke) {
          // Stale only because the host slept — not a wedge. No counting, no exit.
        } else if (isCritical) {
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
        // The heartbeat is tolerated for HEARTBEAT_SUSTAINED_CRITICAL_MS before
        // anything is done about it (a long handler is the usual cause and it
        // recovers on its own), so pinging the operator on first sight was pure
        // noise. It notifies once, from maybeEscalateHeartbeat, when it acts.
        if (r.name === 'daemon.heartbeating') continue;

        await this.notifyOperatorIfEnabled(
          `Robin: ${r.name}`,
          r.message ?? 'critical invariant failed',
        );
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
  private async notifyOperatorIfEnabled(title: string, message: string): Promise<void> {
    const notifyOn =
      typeof this.opts.enableNotifications === 'function'
        ? this.opts.enableNotifications()
        : !!this.opts.enableNotifications;
    if (!notifyOn) return;
    try {
      const llm = this.opts.getLLM() ?? null;
      // Future: use ctx for richer integrations; the fan-out itself needs no ctx.
      buildContext('notify', this.opts.db, llm);
      const { notifyOperator } = await import('../../lib/notify/operator.ts');
      await notifyOperator({ title, message });
    } catch (err) {
      this.log.warn({ err }, 'failed to send health notification');
    }
  }

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
    // Fire-and-forget: the notify path is async and the process is about to exit.
    void this.notifyOperatorIfEnabled(
      'Robin: daemon restarting',
      `scheduler silent ${Math.round(sustainedMs / 60_000)} min — exiting for launchd respawn`,
    );
    try {
      this.opts.onHeartbeatCritical();
    } catch (err) {
      this.log.error({ err }, 'onHeartbeatCritical threw');
    }
  }
}
