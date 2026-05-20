import { join } from 'node:path';
import type { LLMDispatcher } from '../../brain/llm/dispatcher.ts';
import type { RobinDb } from '../../brain/memory/db.ts';
import type { Daemon } from '../../kernel/runtime/daemon.ts';
import { scheduleCronJob } from '../../kernel/scheduler/cron.ts';
import { resolveUserDataDir } from '../../lib/paths.ts';
import { buildContext } from './context.ts';
import { loadIntegrations } from './loader.ts';

/**
 * Load integrations from system/integrations/builtin and user-data/extensions/integrations,
 * register a handler per integration on the daemon, and seed cron schedules for those declaring schedule.
 *
 * Returns count of integrations registered.
 */
export async function registerIntegrations(
  daemon: Daemon,
  db: RobinDb,
  getLLM: () => LLMDispatcher | null | undefined,
  opts: { systemRoot?: string; userDataRoot?: string } = {},
): Promise<{ registered: number; scheduled: number }> {
  const systemRoot = opts.systemRoot ?? join(process.cwd(), 'system/integrations/builtin');
  const userDataRoot = opts.userDataRoot ?? join(resolveUserDataDir(), 'extensions/integrations');

  const loaded = await loadIntegrations([systemRoot, userDataRoot]);

  let scheduled = 0;
  for (const integration of loaded) {
    daemon.registerHandler(`integration.${integration.instanceName}.tick`, async () => {
      const llm = getLLM() ?? null;
      const ctx = buildContext(integration.instanceName, db, llm);
      if (integration.module.tick) {
        await integration.module.tick(ctx);
      }
    });
    if (integration.manifest.schedule && integration.manifest.schedule !== 'manual') {
      // cron schedule string; skip 'event:*' entries (no cron seeding for those)
      if (!integration.manifest.schedule.startsWith('event:')) {
        scheduleCronJob(db, {
          name: `integration.${integration.instanceName}.tick`,
          cron: integration.manifest.schedule,
        });
        scheduled++;
      }
    }
  }

  return { registered: loaded.length, scheduled };
}
