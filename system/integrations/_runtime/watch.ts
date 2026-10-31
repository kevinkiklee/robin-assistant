import { watch } from 'chokidar';
import type { LLMDispatcher } from '../../brain/llm/dispatcher.ts';
import type { RobinDb } from '../../brain/memory/db.ts';
import type { Daemon } from '../../kernel/runtime/daemon.ts';
import { createLogger } from '../../lib/logging/logger.ts';
import { registerIntegrations } from './scheduler-glue.ts';

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
): WatcherHandle {
  const log = createLogger({ module: 'integration-watcher' });
  const w = watch(paths, { ignored: /(^|[/\\])\../, persistent: true, ignoreInitial: true });
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

  w.on('add', onChange).on('change', onChange).on('unlink', onChange);

  return {
    close: async () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      await w.close();
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
