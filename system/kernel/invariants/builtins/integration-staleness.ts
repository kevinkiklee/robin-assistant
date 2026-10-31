import { join } from 'node:path';
import type { LLMDispatcher } from '../../../brain/llm/dispatcher.ts';
import type { RobinDb } from '../../../brain/memory/db.ts';
import { buildContext } from '../../../integrations/_runtime/context.ts';
import { resolveBuiltinIntegrationsRoot } from '../../../integrations/_runtime/gc.ts';
import { loadIntegrations } from '../../../integrations/_runtime/loader.ts';
import { tickWithRetryAndHeartbeat } from '../../../integrations/_runtime/scheduler-glue.ts';
import { createLogger } from '../../../lib/logging/logger.ts';
import { resolveUserDataDir } from '../../../lib/paths.ts';
import type { Policies } from '../../config/schema.ts';
import { lastBootAt } from '../../runtime/boot-classification.ts';
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
export interface IntegrationStalenessOptions {
  /** Enabled, schedule-bearing integrations only. */
  integrations: () => ScheduledIntegration[];
  policies: () => Policies;
  now?: () => Date;
  /** Absolute path to the daemon's boot-history file (boot-classification.ts).
   *  Defaults to `<userData>/state/runtime/boots.json`; tests inject a temp
   *  path so they don't touch the real instance's boot history. */
  bootsPath?: string;
  /** When the daemon process started (epoch ms). Anchors the startup grace —
   *  no verdict on an integration within STARTUP_GRACE_CADENCES × its cadence
   *  of daemon start, since the scheduler hasn't had a chance to tick it yet.
   *  Defaults to the last boot recorded in `bootsPath` (appended once per
   *  daemon start), so the health monitor gets the grace without new wiring;
   *  pass the monitor's `getStartedAt` to use the in-process start time instead. */
  startedAt?: () => number | null | undefined;
  /** Force one on-demand tick for a named integration. Defaults to
   *  `defaultForceTick` below; injectable so tests can assert calls without
   *  actually loading and ticking a real integration. */
  forceTick?: (name: string) => Promise<void>;
  /** LLM getter threaded into the production `forceTick`'s buildContext.
   *  Most integration ticks don't need one; omitted → null. */
  llm?: () => LLMDispatcher | null | undefined;
}

/** Startup/wake grace, in cadences: the first scheduled tick after a start can
 *  land up to one cadence later, plus one cadence for it to run and record. */
const STARTUP_GRACE_CADENCES = 2;

/** A gap this long between two consecutive checks against the same DB means
 *  the process was suspended (laptop sleep) — the health monitor checks every
 *  60s. The wake is then treated like a start for grace purposes. */
const WAKE_GAP_MS = 5 * 60_000;

/** Last check time + last inferred wake per DB handle. Module-level because the
 *  health monitor rebuilds its invariant set every tick (closure state would
 *  reset each time); keyed by DB so independent instances (tests) never mix. */
const checkClock = new WeakMap<object, { lastCheckMs: number; wokeAtMs: number | null }>();

/** Note this check's time and return the most recent inferred wake (epoch ms), if any. */
function observeWake(db: RobinDb, nowMs: number): number | null {
  const prev = checkClock.get(db);
  let wokeAtMs = prev?.wokeAtMs ?? null;
  if (prev && nowMs - prev.lastCheckMs > WAKE_GAP_MS) wokeAtMs = nowMs;
  checkClock.set(db, { lastCheckMs: nowMs, wokeAtMs });
  return wokeAtMs;
}

/**
 * Network-unreachable / fetch-failed class. Staleness caused by the machine
 * being offline (or an upstream DNS/connect failure) is real but not something
 * a local repair or agentic remediation can fix, so it's reported by
 * `integrations.unreachable` (no repair → never escalates) instead of here.
 */
const NETWORK_ERROR =
  /fetch failed|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|ECONNREFUSED|ECONNRESET|ETIMEDOUT|socket hang up|getaddrinfo|network (?:is )?unreachable|offline/i;

export function isNetworkClassError(msg: string | undefined | null): boolean {
  return !!msg && NETWORK_ERROR.test(msg);
}

/**
 * Skip reasons the tick runtime already classified as a transient upstream
 * failure (scheduler-glue's `isTransient` → `skipReason: "transient upstream
 * error: …"`): a 5xx/429, or an integration's own back-off such as whoop's
 * "oauth refresh cooling off after a recent gateway failure". Same class as a
 * network failure — the fault is upstream, the integration recovers on its own,
 * and force-ticking can't help (the repair skips any skip streak). Routed to
 * `integrations.unreachable` so it can't escalate: in 10/23–10/25 whoop
 * cool-offs were 5 of 8 staleness alerts and all 3 agentic escalations, every
 * one ending 'recurred'. Auth-shaped failures never get this prefix
 * (PERSISTENT_AUTH_PATTERNS), so a revoked token still lands in staleness.
 */
const UPSTREAM_TRANSIENT_SKIP = /^transient upstream error:/i;

export function isUpstreamClassSkip(reason: string | undefined | null): boolean {
  return !!reason && (UPSTREAM_TRANSIENT_SKIP.test(reason) || NETWORK_ERROR.test(reason));
}

interface StalenessVerdict {
  critical: string[];
  stale: string[];
  /** Stale/skipping integrations whose last failure is network-class. */
  unreachable: string[];
}

/** Shared evaluation for `integrations.staleness` and `integrations.unreachable`.
 *  Returns null when suppressed wholesale (paused/off, or not online). */
function evaluateStaleness(
  db: RobinDb,
  opts: IntegrationStalenessOptions,
  nowMs: number,
  bootsPath: string,
): StalenessVerdict | null {
  const p = opts.policies();

  // Suppression: ticks aren't running (paused/off) or are expected to skip
  // (local-only/offline). Don't judge freshness we never gave a chance to refresh.
  if (p.power.state !== 'active' || p.network.mode !== 'online') return null;

  const resumedAt = p.power.since ? Date.parse(p.power.since) : 0;
  const startedAt = resolveStartedAt(opts, bootsPath);
  const wokeAt = observeWake(db, nowMs);

  const out: StalenessVerdict = { critical: [], stale: [], unreachable: [] };

  for (const { name, cron } of opts.integrations()) {
    const override = p.alerts.staleness[name];
    if (override?.exempt) continue;

    const cad = cadenceMs(cron);
    if (cad === null) continue; // unparseable schedule — nothing to anchor on

    // Post-resume grace: give the integration one full cadence after a
    // resume before judging it stale.
    if (Number.isFinite(resumedAt) && nowMs - resumedAt < cad) continue;

    // Startup / wake grace: no verdict within 2× cadence of daemon start or of
    // a detected wake from sleep — the 'claude_code: stale 0h' alerts fired in
    // exactly that window, before the scheduler had ticked anything.
    if (withinGrace(nowMs, startedAt, STARTUP_GRACE_CADENCES * cad)) continue;
    if (withinGrace(nowMs, wokeAt, STARTUP_GRACE_CADENCES * cad)) continue;

    const kv = readKv(db, name);

    // Never ticked: fresh install, nothing to judge yet.
    if (kv.last_attempt_at === undefined) continue;

    const skips = Number(kv.consecutive_skips ?? '0');
    const errs = Number(kv.consecutive_errors ?? '0');
    const networkClass =
      (skips > 0 && isUpstreamClassSkip(kv.last_skip_reason)) ||
      (errs > 0 && isNetworkClassError(lastTickError(db, name)));

    // Skip streak: 3+ back-to-back skips is its own unhealthy state,
    // independent of last_ok_at (which can be recent from before the streak).
    if (skips >= 3) {
      const reason = kv.last_skip_reason ?? 'unknown reason';
      (networkClass ? out.unreachable : out.stale).push(`${name}: skipping (${reason})`);
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
      age = errs === 0 ? nowMs - Date.parse(kv.last_attempt_at) : Number.POSITIVE_INFINITY;
    }

    const warnAt = cad * (override?.warn_multiplier ?? DEFAULT_WARN_MULTIPLIER);
    const critAt = cad * (override?.critical_multiplier ?? DEFAULT_CRITICAL_MULTIPLIER);
    if (age > warnAt && networkClass) {
      out.unreachable.push(`${name}: stale ${fmtAge(age)} (network unreachable)`);
    } else if (age > critAt) {
      out.critical.push(`${name}: stale ${fmtAge(age)} (>${DEFAULT_CRITICAL_MULTIPLIER}× cadence)`);
    } else if (age > warnAt) {
      out.stale.push(`${name}: stale ${fmtAge(age)} (>${DEFAULT_WARN_MULTIPLIER}× cadence)`);
    }
  }
  return out;
}

function withinGrace(nowMs: number, anchorMs: number | null | undefined, graceMs: number): boolean {
  if (anchorMs == null || !Number.isFinite(anchorMs)) return false;
  const since = nowMs - anchorMs;
  // A future anchor (clock skew, a test clock behind the real boot file) is ignored.
  return since >= 0 && since < graceMs;
}

function resolveStartedAt(opts: IntegrationStalenessOptions, bootsPath: string): number | null {
  if (opts.startedAt) return opts.startedAt() ?? null;
  const last = lastBootAt(bootsPath);
  if (!last) return null;
  const ms = Date.parse(last);
  return Number.isFinite(ms) ? ms : null;
}

/** Most recent errored tick job's error message for an integration, if any. */
function lastTickError(db: RobinDb, integration: string): string | null {
  try {
    const row = db
      .prepare(
        `SELECT last_error FROM jobs
          WHERE name = ? AND state = 'errored' AND last_error IS NOT NULL
          ORDER BY id DESC LIMIT 1`,
      )
      .get(`integration.${integration}.tick`) as { last_error: string } | undefined;
    return row?.last_error ?? null;
  } catch {
    return null;
  }
}

export function integrationStalenessInvariant(
  db: RobinDb,
  opts: IntegrationStalenessOptions,
): Invariant {
  const now = opts.now ?? (() => new Date());
  const bootsPath = opts.bootsPath ?? join(resolveUserDataDir(), 'state', 'runtime', 'boots.json');
  const forceTick = opts.forceTick ?? defaultForceTick(db, opts.llm ?? (() => null));
  return {
    name: 'integrations.staleness',
    dependsOn: ['daemon.stable', 'daemon.heartbeating'],
    severity: 'warning',
    symptom:
      'A scheduled integration has produced no successful tick in many cadences, or is stuck skipping (e.g. missing secret / revoked OAuth).',
    cause:
      'last_ok_at is older than warn/critical × the integration cadence, or consecutive_skips >= 3. Common roots: scheduler not firing the tick, expired refresh token, or a missing secret causing every tick to skip.',
    fix: 'Run `robin doctor` to see which integrations and why; for OAuth-class skips re-grant with `robin reauth <name>`; for missing secrets add the key to user-data/config/secrets/.env and restart the daemon.',
    check: () => {
      try {
        const v = evaluateStaleness(db, opts, now().getTime(), bootsPath);
        if (!v || (v.critical.length === 0 && v.stale.length === 0)) return { ok: true };
        return {
          ok: false,
          message: [...v.critical.map((s) => `CRITICAL ${s}`), ...v.stale].join('; '),
          remediation: 'robin doctor for detail; robin reauth <name> for OAuth-class skips',
        };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
    },
    // Force-tick catch-up: only fires when (a) a daemon restart happened since
    // the stalest candidate's last success — the plausible root cause a forced
    // tick can actually fix (a scheduler gap around restart) — and (b) each
    // candidate has zero consecutive_skips and no error streak, so we're never
    // forcing a tick on an integration that's actively, persistently broken
    // (that would just fail again — not false-positive-safe). Caps at 3
    // integrations per invocation.
    repair: async () => {
      const p = opts.policies();
      // Mirror check()'s suppression: ticks aren't running (paused/off) or are
      // expected to skip (local-only/offline) — nothing to repair.
      if (p.power.state !== 'active' || p.network.mode !== 'online') return;

      const nowMs = now().getTime();
      const resumedAt = p.power.since ? Date.parse(p.power.since) : 0;

      const candidates: Array<{ name: string; lastOkAt: string; age: number }> = [];
      for (const { name, cron } of opts.integrations()) {
        const override = p.alerts.staleness[name];
        if (override?.exempt) continue;

        const cad = cadenceMs(cron);
        if (cad === null) continue;
        if (Number.isFinite(resumedAt) && nowMs - resumedAt < cad) continue;

        const kv = readKv(db, name);
        if (kv.last_ok_at === undefined) continue; // no known-good baseline to judge from

        const skips = Number(kv.consecutive_skips ?? '0');
        const errs = Number(kv.consecutive_errors ?? '0');
        if (skips !== 0 || errs !== 0) continue; // condition (b): a live skip/error streak isn't safe to force-tick through

        const age = nowMs - Date.parse(kv.last_ok_at);
        const warnAt = cad * (override?.warn_multiplier ?? DEFAULT_WARN_MULTIPLIER);
        if (age <= warnAt) continue; // not actually stale

        candidates.push({ name, lastOkAt: kv.last_ok_at, age });
      }
      if (candidates.length === 0) return;

      candidates.sort((a, b) => b.age - a.age);
      const stalest = candidates[0];

      // Condition (a): a boot must have happened after the stalest candidate's
      // last success — otherwise there's no restart to explain the gap, and a
      // forced tick isn't addressing a plausible cause.
      const lastBoot = lastBootAt(bootsPath);
      if (!lastBoot) return;
      const bootMs = Date.parse(lastBoot);
      if (!Number.isFinite(bootMs) || bootMs <= Date.parse(stalest.lastOkAt)) return;

      for (const c of candidates.slice(0, 3)) {
        await forceTick(c.name);
      }
    },
  };
}

/**
 * Network-class counterpart of `integrations.staleness`: scheduled integrations
 * that are stale or skipping because their last failure was network-unreachable
 * / `fetch failed` (machine offline, DNS down, upstream unreachable). Kept as a
 * separate invariant with NO `repair` on purpose: the incident ladder only
 * escalates to agentic remediation after a repair attempt, so a repair-less
 * invariant stays a plain warning — an agent can't fix the network (the
 * 03:09/12:09 escalations of 2026-09 all ended 'recurred'). Same suppression and
 * startup/wake grace as the staleness check.
 *
 * Wired next to integrationStalenessInvariant in health-monitor.ts and doctor-set.ts.
 */
export function integrationUnreachableInvariant(
  db: RobinDb,
  opts: IntegrationStalenessOptions,
): Invariant {
  const now = opts.now ?? (() => new Date());
  const bootsPath = opts.bootsPath ?? join(resolveUserDataDir(), 'state', 'runtime', 'boots.json');
  return {
    name: 'integrations.unreachable',
    dependsOn: ['daemon.stable', 'daemon.heartbeating'],
    severity: 'warning',
    symptom:
      'A scheduled integration is stale or skipping because its upstream is unreachable (fetch failed / network error) or transiently failing (5xx/429, upstream back-off).',
    cause:
      'The machine is offline, DNS or the upstream host is unreachable, a VPN/captive portal is blocking requests, or the upstream is returning transient errors (e.g. whoop cooling off after a gateway failure). Not a local fault — it clears on its own once the upstream recovers.',
    fix: 'Check connectivity. If the machine is deliberately offline, set network.mode in policies.yaml so freshness checks are suppressed.',
    check: () => {
      try {
        const v = evaluateStaleness(db, opts, now().getTime(), bootsPath);
        if (!v || v.unreachable.length === 0) return { ok: true };
        return {
          ok: false,
          message: v.unreachable.join('; '),
          remediation: 'check network connectivity; clears automatically once ticks succeed',
        };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

/**
 * Production default for `forceTick`. There is no standalone exported
 * "run one integration" helper elsewhere in the codebase — the `run` MCP
 * action (system/surfaces/mcp/extension/server.ts, tool `run`,
 * type=integration) locates the integration the same way: `loadIntegrations`
 * from the builtin + user-data extension roots, `buildContext` for the
 * matched instance. User-data extensions are listed first so a same-named
 * override shadows the builtin, matching `listScheduledIntegrations` in
 * doctor-set.ts.
 *
 * Unlike the MCP `run` action (which calls `match.module.tick(ctx)` bare),
 * this runs the tick through `tickWithRetryAndHeartbeat` — the same armored
 * path the scheduler itself uses for every cron-driven tick. That is load-
 * bearing here, not cosmetic: `last_ok_at`/`consecutive_*` are written ONLY
 * by that wrapper's heartbeat call, so a bare `tick()` would leave the
 * staleness invariant's own state untouched even after a fully successful
 * forced tick — the post-repair re-check would then always still fail,
 * guaranteeing a false escalation. The wrapper also bounds the call to 120s
 * (a hung forced tick must not hang the health monitor's tick) and retries/
 * converts a transient network error to a recorded skip instead of throwing
 * (so one flaky attempt can't notch the repair circuit breaker).
 *
 * Concurrency note: this can race a naturally scheduled cron tick for the
 * same integration firing at roughly the same time — accepted, the same
 * semantics the manual MCP `run` action has always had.
 */
function defaultForceTick(
  db: RobinDb,
  llm: () => LLMDispatcher | null | undefined,
): (name: string) => Promise<void> {
  const log = createLogger({ module: 'integration-staleness-repair' });
  return async (name: string) => {
    const userData = resolveUserDataDir();
    const roots = [join(userData, 'extensions', 'integrations'), resolveBuiltinIntegrationsRoot()];
    const loaded = await loadIntegrations(roots);
    const match = loaded.find((i) => i.instanceName === name || i.manifest.name === name);
    if (!match?.module.tick) return; // integration not found, or has no tick() — nothing to force
    const ctx = buildContext(match.instanceName, db, llm() ?? null);
    await tickWithRetryAndHeartbeat(match.instanceName, match.module, ctx, log);
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
