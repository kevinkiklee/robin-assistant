import type { Daemon } from '../../kernel/runtime/daemon.ts';
import { scheduleCronJob } from '../../kernel/scheduler/cron.ts';
import type { LLMDispatcher } from '../llm/dispatcher.ts';
import type { RobinDb } from '../memory/db.ts';
import { runBiographer } from './biographer.ts';
import { runDream } from './dream.ts';
import { runEmbedBackfill } from './embed-backfill.ts';

export interface CognitionJob {
  name: string;
  cron: string;
  description: string;
}

export const COGNITION_JOBS: CognitionJob[] = [
  {
    name: 'biographer.run',
    cron: '*/15 * * * *',
    description: 'Extract entities + relations from captured sessions',
  },
  {
    name: 'dream.run',
    cron: '0 3 * * *',
    description: 'Nightly consolidation: resolve overdue predictions + metrics + journal',
  },
  {
    // Every minute. Embedding is deferred from the ingest hot-path; this job picks up
    // events_content rows whose embedding is NULL in batches of EMBED_BACKFILL_BATCH (200).
    // scheduleCronJob is idempotent — if a tick is still running, the next one queues
    // rather than overlapping, so Ollama stays single-flight.
    name: 'embed-backfill.run',
    cron: '* * * * *',
    description: 'Embed events_content rows with NULL embedding (deferred from ingest)',
  },
];

/** Register cognition handlers on the daemon and seed their cron schedules. */
export function registerCognitionJobs(
  daemon: Daemon,
  db: RobinDb,
  getLLM: () => LLMDispatcher | null | undefined,
): void {
  daemon.registerHandler('biographer.run', async () => {
    const llm = getLLM() ?? null;
    await runBiographer(db, llm);
  });
  daemon.registerHandler('dream.run', async () => {
    const llm = getLLM() ?? null;
    await runDream(db, llm);
  });
  daemon.registerHandler('embed-backfill.run', async () => {
    const llm = getLLM() ?? null;
    await runEmbedBackfill(db, llm);
  });
  for (const job of COGNITION_JOBS) {
    scheduleCronJob(db, { name: job.name, cron: job.cron });
  }
}
