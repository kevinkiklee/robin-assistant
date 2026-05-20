import { watch } from 'chokidar';
import type { Daemon } from '../../kernel/runtime/daemon.ts';
import type { RobinDb } from '../../brain/memory/db.ts';
import type { LLMDispatcher } from '../../brain/llm/dispatcher.ts';
import { registerIntegrations } from './scheduler-glue.ts';
import { createLogger } from '../../lib/logging/logger.ts';

export interface WatcherHandle {
  close: () => Promise<void>;
}

/**
 * Watch the integration directories. On change, debounce 200ms then re-register integrations.
 * Returns a handle that can be closed on daemon shutdown.
 */
export function watchIntegrations(
  daemon: Daemon,
  db: RobinDb,
  getLLM: () => LLMDispatcher | null | undefined,
  paths: string[],
): WatcherHandle {
  const log = createLogger({ module: 'integration-watcher' });
  const w = watch(paths, { ignored: /(^|[\/\\])\../, persistent: true, ignoreInitial: true });
  let debounceTimer: NodeJS.Timeout | null = null;

  const reload = async () => {
    try {
      const r = await registerIntegrations(daemon, db, getLLM);
      log.info({ registered: r.registered, scheduled: r.scheduled }, 'integrations reloaded');
    } catch (err) {
      log.error({ err }, 'integration reload failed');
    }
  };

  const onChange = (path: string) => {
    log.debug({ path }, 'integration file changed');
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => { void reload(); }, 200);
  };

  w.on('add', onChange).on('change', onChange).on('unlink', onChange);

  return {
    close: async () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      await w.close();
    },
  };
}
