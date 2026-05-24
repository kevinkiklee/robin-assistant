import type { Daemon } from '../../kernel/runtime/daemon.ts';
import { scheduleCronJob } from '../../kernel/scheduler/cron.ts';
import type { LLMDispatcher } from '../llm/dispatcher.ts';
import type { RobinDb } from '../memory/db.ts';
import { runBiographer } from './biographer.ts';
import { runDream } from './dream.ts';
import { runEmbedder } from './embedder.ts';

export interface CognitionJob {
  name: string;
  cron: string;
  description: string;
}

export const COGNITION_JOBS: CognitionJob[] = [
  {
    name: 'biographer.run',
    cron: '*/5 * * * *',
    description: 'Extract entities + relations from captured sessions',
  },
  {
    name: 'dream.run',
    cron: '0 3 * * *',
    description: 'Nightly consolidation: resolve overdue predictions + metrics + journal',
  },
  {
    // Every minute. Embedding is deferred from the ingest hot-path; this job picks up
    // events_content rows whose embedding is NULL in batches of EMBEDDER_BATCH (200).
    // scheduleCronJob is idempotent — if a tick is still running, the next one queues
    // rather than overlapping, so Ollama stays single-flight.
    name: 'embedder.run',
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
    // Batch = 5 sessions per tick. The chunk budget (MAX_CHUNKS_PER_TICK=10) is
    // the real time guard (~30s/chunk on 14b → ~5 min worst case per tick, well
    // under the 30-min heartbeat gate). Raising batch from 1 lets the biographer
    // drain multiple small sessions per tick instead of wasting leftover budget.
    // Combined with the */5 cron, throughput is ~2 chunks/min (was ~0.27 at
    // batch=1/*/15/4-chunk).
    await runBiographer(db, llm, 5);
  });
  daemon.registerHandler('dream.run', async () => {
    const llm = getLLM() ?? null;
    await runDream(db, llm);
  });
  daemon.registerHandler('embedder.run', async () => {
    const llm = getLLM() ?? null;
    await runEmbedder(db, llm);
  });
  for (const job of COGNITION_JOBS) {
    scheduleCronJob(db, { name: job.name, cron: job.cron });
  }
}
