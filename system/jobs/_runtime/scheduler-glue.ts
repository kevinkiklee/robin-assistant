import { join } from 'node:path';
import type { LLMDispatcher } from '../../brain/llm/dispatcher.ts';
import type { RobinDb } from '../../brain/memory/db.ts';
import type { Daemon } from '../../kernel/runtime/daemon.ts';
import { scheduleCronJob } from '../../kernel/scheduler/cron.ts';
import { createLogger } from '../../lib/logging/logger.ts';
import { resolveUserDataDir } from '../../lib/paths.ts';
import { buildJobContext } from './context.ts';
import { loadJobs } from './loader.ts';

export interface JobsRegisterResult {
  registered: number;
  scheduled: number;
}

/**
 * Load jobs from user-data/extensions/jobs/*, register a daemon handler per job,
 * and seed cron schedules for those that declare a cron expression.
 */
export async function registerJobs(
  daemon: Daemon,
  db: RobinDb,
  getLLM: () => LLMDispatcher | null | undefined,
  opts: { systemRoot?: string; userDataRoot?: string } = {},
): Promise<JobsRegisterResult> {
  const systemRoot = opts.systemRoot ?? join(process.cwd(), 'system/jobs/builtin');
  const userDataRoot = opts.userDataRoot ?? join(resolveUserDataDir(), 'extensions/jobs');
  const log = createLogger({ module: 'jobs' });

  const loaded = await loadJobs([systemRoot, userDataRoot]);
  let scheduled = 0;
  for (const j of loaded) {
    daemon.registerHandler(`job.${j.instanceName}.run`, async () => {
      const llm = getLLM() ?? null;
      const ctx = buildJobContext(j.instanceName, j.rootDir, db, llm);
      try {
        const result = await j.module.run(ctx);
        if (result?.status === 'error') {
          log.warn({ job: j.instanceName, msg: result.message }, 'job returned error');
        }
      } catch (err) {
        log.error({ err, job: j.instanceName }, 'job handler threw');
      }
    });
    if (j.manifest.schedule && j.manifest.schedule !== 'manual') {
      if (!j.manifest.schedule.startsWith('event:')) {
        scheduleCronJob(db, {
          name: `job.${j.instanceName}.run`,
          cron: j.manifest.schedule,
          tz: j.manifest.tz,
        });
        scheduled++;
      }
    }
  }

  return { registered: loaded.length, scheduled };
}
