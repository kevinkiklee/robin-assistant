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
    // Batch is 1 because qwen3:14b on M5 Max realistically takes ~11 min per session
    // (much slower than the original 25/tick design assumed). With batch=25 a single
    // tickOnce would hold the scheduler for hours, blocking `lastTickAt` updates and
    // triggering Bug A's 30-min heartbeat-sustained-CRITICAL recovery in a loop.
    // batch=1 keeps each tick bounded at ~11 min — well under the recovery threshold —
    // and the cron re-arm (Bug C fix) ensures continuous draining of the backlog.
    // Throughput is unchanged in practice: batch=25 in the loop world produced ~3
    // sessions per 30-min restart cycle ≈ 5-6/hr; batch=1 with cron */15 produces
    // ~4/hr but without restart-loss of in-flight work.
    await runBiographer(db, llm, 1);
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
