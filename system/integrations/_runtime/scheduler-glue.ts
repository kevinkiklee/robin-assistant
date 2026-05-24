import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LLMDispatcher } from '../../brain/llm/dispatcher.ts';
import type { RobinDb } from '../../brain/memory/db.ts';
import type { Daemon } from '../../kernel/runtime/daemon.ts';
import { scheduleCronJob } from '../../kernel/scheduler/cron.ts';
import { createLogger } from '../../lib/logging/logger.ts';
import { resolveUserDataDir } from '../../lib/paths.ts';
import { withTimeout } from '../../lib/with-timeout.ts';
import { buildContext } from './context.ts';
import { loadIntegrations } from './loader.ts';
import type { Integration, IntegrationContext } from './types.ts';

/**
 * Resolve the builtin-integrations root by walking up from this module's location, NOT
 * from process.cwd(). Under launchd the daemon's cwd is user-data/ (so cwd-relative
 * paths land in the wrong place and the builtin loader silently finds nothing).
 *
 * This module lives at `<root>/{system|dist}/integrations/_runtime/scheduler-glue.{ts|js}`.
 * Walk up three levels to get to <root>, then look for builtins next to wherever we are.
 * Both layouts are tried so the same code path works for `pnpm dev` (tsx → system/) and
 * the published binary (node → dist/).
 */
function resolveBuiltinIntegrationsRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // here = .../system/integrations/_runtime  or  .../dist/integrations/_runtime
  const candidate = join(here, '..', 'builtin');
  if (existsSync(candidate)) return candidate;
  // Last-ditch fallback to cwd-relative; preserves pre-fix behavior for unusual layouts.
  return join(process.cwd(), 'system/integrations/builtin');
}

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
  outcome: { ok: boolean; ingested: number; skipReason?: string },
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
  for (let attempt = 0; attempt < 2; attempt++) {
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
      if (attempt === 0 && isTransient(err)) {
        log.info(
          { integration: integrationName, err: err instanceof Error ? err.message : String(err) },
          'integration tick transient error — retrying once',
        );
        await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));
        continue;
      }
      writeHeartbeat(ctx.db, integrationName, { ok: false, ingested: 0 });
      throw err;
    }
  }
  // Both attempts failed transiently
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

  return { registered: loaded.length, scheduled, initialized, cleanup };
}
