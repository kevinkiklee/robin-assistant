import type { Daemon } from '../../kernel/runtime/daemon.ts';
import { scheduleCronJob } from '../../kernel/scheduler/cron.ts';
import { resolveUserDataDir } from '../../lib/paths.ts';
import type { LLMDispatcher } from '../llm/dispatcher.ts';
import type { RobinDb } from '../memory/db.ts';
import { runBiographer } from './biographer.ts';
import { runDream } from './dream.ts';
import { runEmbedder } from './embedder.ts';
import { ingestContentDocs } from './ingest-docs.ts';

export interface CognitionJob {
  name: string;
  cron: string;
  description: string;
}

export const COGNITION_JOBS: CognitionJob[] = [
  {
    name: 'biographer.run',
    cron: '*/2 * * * *',
    description: 'Extract entities + relations from captured sessions',
  },
  {
    name: 'dream.run',
    // 3:50am — runs FIRST, before the 4:00am dream-synthesis deep pass, to
    // consolidate the deterministic substrate that pass reasons on. No explicit
    // tz: so it resolves via ROBIN_TZ → system TZ → UTC, the SAME precedence the
    // daily-brief (4:30am) and dream-synthesis (4:00am) jobs use — keeping the
    // 3:50/4:00/4:30 ordering intact under any single configured timezone.
    cron: '50 3 * * *',
    description:
      'Nightly substrate maintenance (deterministic): resolve overdue predictions + metrics rollup + arc detection + staleness flags + candidate expiry + doc ingest + metrics-only journal fallback',
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
  {
    // Indexes content/knowledge + content/profile *.md into recall so the user
    // never has to run `robin ingest-docs` by hand. Idempotent + content-hashed:
    // unchanged files are skipped, so a frequent cron is cheap. Embedding is
    // deferred to embedder.run, so this stays fast even on first index.
    name: 'ingest-docs.run',
    cron: '*/10 * * * *',
    description: 'Index content/knowledge + content/profile *.md into recall (idempotent)',
  },
];

/**
 * Register cognition handlers on the daemon and seed their cron schedules.
 *
 * `getDraftClaims` resolves the `biographer.draftClaims` policy at handler time
 * (so flipping policies.yaml takes effect without a daemon restart). Defaults to
 * `true` — the schema default — when the daemon does not supply one.
 */
export function registerCognitionJobs(
  daemon: Daemon,
  db: RobinDb,
  getLLM: () => LLMDispatcher | null | undefined,
  getDraftClaims: () => boolean = () => true,
): void {
  daemon.registerHandler('biographer.run', async () => {
    const llm = getLLM() ?? null;
    // Batch = 5 sessions per tick. The chunk budget (MAX_CHUNKS_PER_TICK=10) is
    // the real time guard (~30s/chunk on 14b → ~5 min worst case per tick, well
    // under the 30-min heartbeat gate). Raising batch from 1 lets the biographer
    // drain multiple small sessions per tick instead of wasting leftover budget.
    // Combined with the */5 cron, throughput is ~2 chunks/min (was ~0.27 at
    // batch=1/*/15/4-chunk).
    // Cranked for backlog drain: 15 sessions/tick, batch 5 chunks/invoke, every
    // 2 min. ~150+ sessions/hr vs the prior ~12. The 7-min heartbeat ceiling is
    // the safety net; a tick that overruns trips the heartbeat and the scheduler
    // recovers on the next tick. Revert to 5/3/*/5 once the backlog is clear.
    await runBiographer(db, llm, 15, {
      batchChunks: 5,
      skipToolChunks: true,
      draftClaims: getDraftClaims(),
    });
  });
  daemon.registerHandler('dream.run', async () => {
    const llm = getLLM() ?? null;
    await runDream(db, llm);
  });
  daemon.registerHandler('embedder.run', async () => {
    const llm = getLLM() ?? null;
    await runEmbedder(db, llm);
  });
  daemon.registerHandler('ingest-docs.run', () => {
    const llm = getLLM() ?? null;
    ingestContentDocs(db, llm, { userDataDir: resolveUserDataDir() });
  });
  for (const job of COGNITION_JOBS) {
    scheduleCronJob(db, { name: job.name, cron: job.cron });
  }
}
