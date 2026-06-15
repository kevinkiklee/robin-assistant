import { join } from 'node:path';
import type { LLMDispatcher } from '../../brain/llm/dispatcher.ts';
import type { RobinDb } from '../../brain/memory/db.ts';
import type { Daemon } from '../../kernel/runtime/daemon.ts';
import { scheduleCronJob } from '../../kernel/scheduler/cron.ts';
import { createLogger } from '../../lib/logging/logger.ts';
import { resolveUserDataDir } from '../../lib/paths.ts';
import { withTimeout } from '../../lib/with-timeout.ts';
import { buildContext } from './context.ts';
// GC helpers + the builtin-root resolver moved to gc.ts (cycle-free, kernel-import-free)
// so kernel/invariants can reuse them. Re-exported below for back-compat.
import {
  gcOrphanIntegrationTicks,
  gcRemovedIntegrationState,
  resolveBuiltinIntegrationsRoot,
} from './gc.ts';
import { listOnDiskIntegrationNames, loadIntegrations } from './loader.ts';
import type { Integration, IntegrationContext } from './types.ts';

/** A scheduled integration: instance name + the cron expression it ticks on. */
export interface ScheduledIntegrationSpec {
  name: string;
  cron: string;
}

export {
  gcOrphanIntegrationTicks,
  gcRemovedIntegrationState,
  resolveBuiltinIntegrationsRoot,
} from './gc.ts';

const TRANSIENT_PATTERNS = [
  /fetch failed/i,
  /ECONNRESET/i,
  /ETIMEDOUT/i,
  /ENETUNREACH/i,
  /EAI_AGAIN/i,
  /socket hang up/i,
];
const PERSISTENT_AUTH_PATTERNS = [/invalid_grant/i, /401/, /403/, /oauth.*4\d\d/i];
const RETRY_BACKOFF_MS = 2000;
// Total tick attempts (initial + retries) before a transient failure is given
// up on. Raised from 2 (single retry) after a wttr.in ECONNRESET reset twice in
// a 3.5s window and tripped the morning brief's health alert: free, no-auth
// upstreams (wttr.in) reset connections in short bursts, so a couple of
// backed-off retries turn most into successes.
const MAX_TICK_ATTEMPTS = 3;
// Bound how long a single handler invocation can block the scheduler's await.
// A wedged handler used to take down the entire tick loop (Bug A), which
// only recovered when the 30-min sustained-CRITICAL health gate exited the
// daemon. 120s is generously above any healthy handler latency, well below
// the health gate, and well below the 5-min lease window so a timed-out
// handler's lease can still be reaped.
const HANDLER_TIMEOUT_MS = 120_000;

function isTransient(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  // Auth failures shaped like fetch errors must NOT retry — they're persistent and
  // retrying them burns rate-limit quota.
  if (PERSISTENT_AUTH_PATTERNS.some((re) => re.test(msg))) return false;
  return TRANSIENT_PATTERNS.some((re) => re.test(msg));
}

/**
 * Write per-integration heartbeat into `integration_state`. Three keys are tracked so
 * the doctor / invariants / `robin integrations` verb can answer:
 *   - last_attempt_at: when did we last try? (catches "scheduler stopped firing me")
 *   - last_ingest_count: did the last attempt actually produce content? (separates
 *     "successful but no new data" from "successful and ingesting")
 *   - consecutive_errors: rolling count of back-to-back failures (resets on success);
 *     becomes the signal the invariant fires on. Persists across daemon restarts.
 */
function writeHeartbeat(
  db: import('../../brain/memory/db.ts').RobinDb,
  integrationName: string,
  outcome: { ok: boolean; ingested: number; skipReason?: string; degraded?: string[] },
): void {
  const now = new Date().toISOString();
  const setKv = db.prepare(`
    INSERT INTO integration_state (integration_name, key, value, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(integration_name, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);
  const delKv = db.prepare(`DELETE FROM integration_state WHERE integration_name = ? AND key = ?`);
  setKv.run(integrationName, 'last_attempt_at', now, now);
  if (outcome.ok) {
    setKv.run(integrationName, 'consecutive_errors', '0', now);
    if (outcome.skipReason) {
      // Skip-streak counter, mirroring consecutive_errors: a back-to-back run of
      // skips ("secrets missing", "auth revoked") is its own unhealthy state the
      // staleness invariant fires on, distinct from an error streak. Increments on
      // every skip, resets to '0' on a clean ok tick below; errors leave it alone.
      const priorSkips = Number(
        (
          db
            .prepare(
              `SELECT value FROM integration_state WHERE integration_name = ? AND key = 'consecutive_skips'`,
            )
            .get(integrationName) as { value?: string } | undefined
        )?.value ?? '0',
      );
      setKv.run(integrationName, 'consecutive_skips', String(priorSkips + 1), now);
    } else {
      setKv.run(integrationName, 'consecutive_skips', '0', now);
      setKv.run(integrationName, 'last_ok_at', now, now);
      // Degraded counters mutate ONLY on clean ok ticks. Skip ticks (auth/secrets
      // missing) intentionally FREEZE them — a skip tells us nothing about stream
      // health, and resetting would mask a persistent degraded stream behind a
      // skip streak.
      // Track per-stream degraded counters. A degraded tick is still a successful tick
      // (last_ok_at written above), but we maintain a rolling count per stream name so
      // the integration-degraded invariant can fire when a stream fails persistently.
      const degraded = new Set(outcome.degraded ?? []);
      const existingRows = db
        .prepare(
          `SELECT key, value FROM integration_state WHERE integration_name = ? AND key LIKE 'degraded:%'`,
        )
        .all(integrationName) as Array<{ key: string; value: string }>;
      for (const s of degraded) {
        const prev = Number(existingRows.find((r) => r.key === `degraded:${s}`)?.value ?? '0');
        setKv.run(integrationName, `degraded:${s}`, String(prev + 1), now);
      }
      // Reset any previously-degraded streams that are healthy this tick.
      for (const r of existingRows) {
        if (!degraded.has(r.key.slice('degraded:'.length))) {
          setKv.run(integrationName, r.key, '0', now);
        }
      }
    }
    if (outcome.ingested > 0) {
      setKv.run(integrationName, 'last_ingest_at', now, now);
      setKv.run(integrationName, 'last_ingest_count', String(outcome.ingested), now);
    }
    // A skipped tick is "successful" in the scheduler sense (no error, no retry)
    // but unhealthy from a sync-status sense — `skipped` is how integrations
    // signal "secrets missing", "auth revoked", or "no work to do". Persist the
    // reason so the brief / doctor / invariants surface it instead of letting it
    // look identical to a healthy ingest-zero run.
    if (outcome.skipReason) {
      setKv.run(integrationName, 'last_skip_reason', outcome.skipReason, now);
      setKv.run(integrationName, 'last_skip_at', now, now);
    } else {
      delKv.run(integrationName, 'last_skip_reason');
      delKv.run(integrationName, 'last_skip_at');
    }
  } else {
    const prior = Number(
      (
        db
          .prepare(
            `SELECT value FROM integration_state WHERE integration_name = ? AND key = 'consecutive_errors'`,
          )
          .get(integrationName) as { value?: string } | undefined
      )?.value ?? '0',
    );
    setKv.run(integrationName, 'consecutive_errors', String(prior + 1), now);
  }
}

async function tickWithRetryAndHeartbeat(
  integrationName: string,
  module: {
    tick?: (
      ctx: import('./types.ts').IntegrationContext,
    ) => Promise<import('./types.ts').TickResult> | import('./types.ts').TickResult;
  },
  ctx: import('./types.ts').IntegrationContext,
  log: ReturnType<typeof createLogger>,
): Promise<void> {
  if (!module.tick) return;
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_TICK_ATTEMPTS; attempt++) {
    try {
      const result = await withTimeout(
        Promise.resolve(module.tick(ctx)),
        HANDLER_TIMEOUT_MS,
        `integration '${integrationName}' tick exceeded ${HANDLER_TIMEOUT_MS}ms`,
      );
      // tick() returns may have status='skipped' (e.g. secrets missing, auth
      // revoked) — count as ok-but-no-ingest for retry purposes, but record the
      // skip reason so it doesn't look identical to a healthy ingest-zero run.
      // Only status='error' or a thrown exception count as failure.
      const ok = result?.status !== 'error';
      const skipReason = result?.status === 'skipped' ? result?.message : undefined;
      writeHeartbeat(ctx.db, integrationName, {
        ok,
        ingested: result?.ingested ?? 0,
        skipReason,
        degraded: result?.degraded,
      });
      if (!ok && result?.message) {
        log.warn(
          { integration: integrationName, msg: result.message },
          'integration tick reported error',
        );
      } else if (skipReason) {
        log.warn({ integration: integrationName, msg: skipReason }, 'integration tick skipped');
      }
      return;
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      // Transient network error with retries left → back off (linearly) and retry.
      if (isTransient(err) && attempt < MAX_TICK_ATTEMPTS - 1) {
        log.info(
          { integration: integrationName, err: msg, attempt: attempt + 1 },
          'integration tick transient error — retrying',
        );
        await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS * (attempt + 1)));
        continue;
      }
      // Retries exhausted (or a non-transient error on the first attempt).
      if (isTransient(err)) {
        // A transient network failure that survives every retry is a self-healing
        // upstream blip, NOT a code or health fault. Record it as a SKIP rather
        // than throwing: a thrown handler marks the job row `errored` and trips
        // the `jobs.not_erroring` invariant on a single blip (a lone wttr.in
        // ECONNRESET surfaced as a morning brief "system health" warning). The
        // skip still feeds `consecutive_skips` + the staleness invariant, so a
        // SUSTAINED outage (many back-to-back skips) is still surfaced — just not
        // a one-off reset. The reason is persisted to `last_skip_reason`.
        writeHeartbeat(ctx.db, integrationName, {
          ok: true,
          ingested: 0,
          skipReason: `transient upstream error: ${msg.slice(0, 140)}`,
        });
        log.warn(
          { integration: integrationName, err: msg },
          'integration tick transient failure after retries — recorded as skip',
        );
        return;
      }
      writeHeartbeat(ctx.db, integrationName, { ok: false, ingested: 0 });
      throw err;
    }
  }
  // Unreachable: the final attempt always returns or throws above. Kept so the
  // function is total if MAX_TICK_ATTEMPTS is ever set to 0.
  writeHeartbeat(ctx.db, integrationName, { ok: false, ingested: 0 });
  throw lastErr;
}

interface ActiveIntegration {
  name: string;
  module: Integration;
  ctx: IntegrationContext;
}

export interface RegisterResult {
  registered: number;
  scheduled: number;
  initialized: number;
  /** Enabled, schedule-bearing integrations (non-manual, non-event cron) — instance
   *  name + cron. Fed to the integration-staleness invariant so it knows which
   *  integrations to judge freshness on, anchored to their cadence. */
  scheduledIntegrations: ScheduledIntegrationSpec[];
  /** Calls cleanup() on every integration that successfully ran init(). Safe to call once on daemon stop. */
  cleanup: () => Promise<void>;
}

/**
 * Load integrations from system/integrations/builtin and user-data/extensions/integrations,
 * register a handler per integration on the daemon, seed cron schedules for those declaring one,
 * and run each integration's init() once so gateway-style integrations (Discord, etc.) can hold
 * long-lived clients across ticks. Returns a cleanup() the daemon invokes on shutdown.
 */
export async function registerIntegrations(
  daemon: Daemon,
  db: RobinDb,
  getLLM: () => LLMDispatcher | null | undefined,
  opts: { systemRoot?: string; userDataRoot?: string } = {},
): Promise<RegisterResult> {
  const systemRoot = opts.systemRoot ?? resolveBuiltinIntegrationsRoot();
  const userDataRoot = opts.userDataRoot ?? join(resolveUserDataDir(), 'extensions/integrations');
  const log = createLogger({ module: 'integrations' });

  const loaded = await loadIntegrations([systemRoot, userDataRoot]);
  const active: ActiveIntegration[] = [];

  let scheduled = 0;
  let initialized = 0;
  const scheduledIntegrations: ScheduledIntegrationSpec[] = [];
  for (const integration of loaded) {
    daemon.registerHandler(`integration.${integration.instanceName}.tick`, async () => {
      const llm = getLLM() ?? null;
      const ctx = buildContext(integration.instanceName, db, llm);
      if (!integration.module.tick) return;
      // Wrap each tick with:
      //   1. Single retry on transient network errors (`fetch failed`, ECONNRESET, ETIMEDOUT,
      //      EAI_AGAIN). Today's data showed 10-25% raw failure rates on whoop/linear/spotify
      //      from these — a single retry with brief backoff turns most of them into successes.
      //      Auth errors (`invalid_grant`, 401, 403) are NOT retried — those are persistent.
      //   2. Heartbeat: write last_attempt_at + consecutive_errors + (on success) last_ingest_at
      //      to integration_state so the freshness invariant can catch silent breakage.
      await tickWithRetryAndHeartbeat(integration.instanceName, integration.module, ctx, log);
    });
    if (integration.manifest.schedule && integration.manifest.schedule !== 'manual') {
      if (!integration.manifest.schedule.startsWith('event:')) {
        scheduleCronJob(db, {
          name: `integration.${integration.instanceName}.tick`,
          cron: integration.manifest.schedule,
          tz: integration.manifest.tz,
        });
        scheduled++;
        scheduledIntegrations.push({
          name: integration.instanceName,
          cron: integration.manifest.schedule,
        });
      }
    }

    if (integration.module.init) {
      const ctx = buildContext(integration.instanceName, db, getLLM() ?? null);
      try {
        await integration.module.init(ctx);
        active.push({ name: integration.instanceName, module: integration.module, ctx });
        initialized++;
      } catch (err) {
        log.error(
          { err, integration: integration.instanceName },
          'integration init() failed; tick handler still registered but long-lived state will be missing',
        );
      }
    }
  }

  // Drop tick crons left behind by integrations that no longer exist, so a
  // removed integration can't error every tick forever (the github/embed-backfill
  // failure mode). Runs after the live set is known.
  const liveTickNames = new Set(loaded.map((i) => `integration.${i.instanceName}.tick`));
  const gcedTicks = gcOrphanIntegrationTicks(db, liveTickNames, log);
  if (gcedTicks > 0) log.info({ gcedTicks }, 'GC orphaned integration tick crons');

  // Also drop the leftover KV/heartbeat state of integrations whose directory is
  // gone (github tombstone), so the status report stops listing phantoms. Keyed
  // on on-disk dirs (not `loaded`) so a failed-to-compile extension keeps its
  // tokens. resolveBuiltinIntegrationsRoot() always exists; if neither root
  // resolves, the empty-set guard inside makes this a no-op.
  const onDiskNames = listOnDiskIntegrationNames([systemRoot, userDataRoot]);
  const gcedState = gcRemovedIntegrationState(db, onDiskNames, log);
  if (gcedState > 0) log.info({ gcedState }, 'GC state rows for removed integrations');

  const cleanup = async (): Promise<void> => {
    for (const item of active) {
      if (!item.module.cleanup) continue;
      try {
        await item.module.cleanup(item.ctx);
      } catch (err) {
        log.error({ err, integration: item.name }, 'integration cleanup() failed');
      }
    }
  };

  return { registered: loaded.length, scheduled, initialized, scheduledIntegrations, cleanup };
}
