import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LLMDispatcher } from '../../brain/llm/dispatcher.ts';
import type { RobinDb } from '../../brain/memory/db.ts';
import type { Daemon } from '../../kernel/runtime/daemon.ts';
import { scheduleCronJob } from '../../kernel/scheduler/cron.ts';
import { assertCanRunIntegrations } from '../../lib/cloud/role.ts';
import { createLogger } from '../../lib/logging/logger.ts';
import { resolveUserDataDir } from '../../lib/paths.ts';
import { platformSkipLabel, runsOnThisPlatform } from '../../lib/platform.ts';
import { buildJobContext } from './context.ts';
import { loadJobs } from './loader.ts';

/**
 * Resolve the builtin-jobs root from this module's location, not process.cwd().
 * See system/integrations/_runtime/scheduler-glue.ts for the rationale — same launchd
 * cwd-mismatch bug class. No builtin jobs exist today (daily-brief lives as an extension),
 * but the path matters whenever a future job ships in the published package.
 */
function resolveBuiltinJobsRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidate = join(here, '..', 'builtin');
  if (existsSync(candidate)) return candidate;
  return join(process.cwd(), 'system/jobs/builtin');
}

export interface JobsRegisterResult {
  registered: number;
  scheduled: number;
  /** Jobs not registered because their `platforms:` excludes this OS. */
  platformSkipped: Array<{ name: string; reason: string }>;
}

/**
 * Load jobs from user-data/extensions/jobs/*, register a daemon handler per job,
 * and seed cron schedules for those that declare a cron expression.
 */
export async function registerJobs(
  daemon: Daemon,
  db: RobinDb,
  getLLM: () => LLMDispatcher | null | undefined,
  opts: { systemRoot?: string; userDataRoot?: string; platform?: string } = {},
): Promise<JobsRegisterResult> {
  const systemRoot = opts.systemRoot ?? resolveBuiltinJobsRoot();
  const userDataRoot = opts.userDataRoot ?? join(resolveUserDataDir(), 'extensions/jobs');
  const log = createLogger({ module: 'jobs' });

  const all = await loadJobs([systemRoot, userDataRoot]);
  const loaded = all.filter((j) => runsOnThisPlatform(j.manifest, opts.platform));
  const platformSkipped = all
    .filter((j) => !loaded.includes(j))
    .map((j) => ({ name: j.instanceName, reason: platformSkipLabel(j.manifest) }));
  for (const s of platformSkipped) log.info({ job: s.name }, s.reason);
  let scheduled = 0;
  for (const j of loaded) {
    daemon.registerHandler(`job.${j.instanceName}.run`, async () => {
      assertCanRunIntegrations(resolveUserDataDir());
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

  return { registered: loaded.length, scheduled, platformSkipped };
}
