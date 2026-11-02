import { watch } from 'chokidar';
import type { LLMDispatcher } from '../../brain/llm/dispatcher.ts';
import type { RobinDb } from '../../brain/memory/db.ts';
import type { Daemon } from '../../kernel/runtime/daemon.ts';
import { createLogger } from '../../lib/logging/logger.ts';
import { registerIntegrations } from './scheduler-glue.ts';

/** How long a failed watcher waits before trying again. */
const WATCH_RETRY_MS = 10 * 60_000;

export interface WatcherHandle {
  close: () => Promise<void>;
  /** Latest cleanup function from the most recent re-registration; daemon stop should call this. */
  getLatestCleanup: () => (() => Promise<void>) | undefined;
}

/**
 * Watch the integration directories. On change, debounce 200ms then re-register integrations.
 * Calls cleanup() on the previous registration before re-registering so gateway integrations
 * (Discord, etc.) don't leak long-lived clients on each reload. Returns a handle that can be
 * closed on daemon shutdown.
 */
export function watchIntegrations(
  daemon: Daemon,
  db: RobinDb,
  getLLM: () => LLMDispatcher | null | undefined,
  paths: string[],
  deps: { watch?: typeof watch; retryMs?: number } = {},
): WatcherHandle {
  const log = createLogger({ module: 'integration-watcher' });
  const retryMs = deps.retryMs ?? WATCH_RETRY_MS;
  let w: ReturnType<typeof watch> | null = null;
  let retryTimer: NodeJS.Timeout | null = null;
  let closed = false;

  // Without an 'error' listener a watcher failure is thrown and kills the
  // daemon; launchd then crash-loops it on every boot. The usual cause is
  // EMFILE when macOS runs out of FSEvents capacity, which clears once the
  // pressure does. Hot reload is a convenience: stop watching, keep running,
  // and try again later.
  const start = () => {
    retryTimer = null;
    if (closed) return;
    const inst = (deps.watch ?? watch)(paths, {
      ignored: /(^|[/\\])\../,
      persistent: true,
      ignoreInitial: true,
    });
    w = inst;
    let failed = false;
    inst.on('error', (err) => {
      if (failed || closed) return;
      failed = true;
      log.warn({ err, retryInMs: retryMs }, 'integration watcher failed; hot reload paused');
      if (w === inst) w = null;
      void inst.close().catch(() => {});
      retryTimer = setTimeout(start, retryMs);
      retryTimer.unref?.();
    });
    inst.on('add', onChange).on('change', onChange).on('unlink', onChange);
  };
  let debounceTimer: NodeJS.Timeout | null = null;
  let currentCleanup: (() => Promise<void>) | undefined;

  const reload = async () => {
    try {
      // Tear down the previous registration before re-registering so init() side
      // effects (long-lived clients, subscriptions) don't accumulate per reload.
      if (currentCleanup) {
        try {
          await currentCleanup();
        } catch (err) {
          log.error({ err }, 'previous-registration cleanup failed; continuing reload');
        }
        currentCleanup = undefined;
      }
      const r = await registerIntegrations(daemon, db, getLLM);
      currentCleanup = r.cleanup;
      log.info(
        { registered: r.registered, scheduled: r.scheduled, initialized: r.initialized },
        'integrations reloaded',
      );
    } catch (err) {
      log.error({ err }, 'integration reload failed');
    }
  };

  const onChange = (path: string) => {
    log.debug({ path }, 'integration file changed');
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      void reload();
    }, 200);
  };

  start();

  return {
    close: async () => {
      closed = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      if (retryTimer) clearTimeout(retryTimer);
      await w?.close();
      if (currentCleanup) {
        try {
          await currentCleanup();
        } catch {
          // already logged elsewhere
        }
      }
    },
    getLatestCleanup: () => currentCleanup,
  };
}
