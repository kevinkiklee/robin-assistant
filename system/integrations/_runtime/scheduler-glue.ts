import { join } from 'node:path';
import type { LLMDispatcher } from '../../brain/llm/dispatcher.ts';
import type { RobinDb } from '../../brain/memory/db.ts';
import type { Daemon } from '../../kernel/runtime/daemon.ts';
import { scheduleCronJob } from '../../kernel/scheduler/cron.ts';
import { createLogger } from '../../lib/logging/logger.ts';
import { resolveUserDataDir } from '../../lib/paths.ts';
import { buildContext } from './context.ts';
import { loadIntegrations } from './loader.ts';
import type { Integration, IntegrationContext } from './types.ts';

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
  const systemRoot = opts.systemRoot ?? join(process.cwd(), 'system/integrations/builtin');
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
      if (integration.module.tick) {
        await integration.module.tick(ctx);
      }
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
