import { buildDoctorInvariants } from '../../kernel/invariants/doctor-set.ts';
import { runInvariants } from '../../kernel/invariants/runner.ts';
import type { Daemon } from '../../kernel/runtime/daemon.ts';
import { scheduleCronJob } from '../../kernel/scheduler/cron.ts';
import { createLogger } from '../../lib/logging/logger.ts';
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
    cron: '* * * * *',
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
  {
    // 4:15am — after dream-synthesis (4:00) cleans up the night's writes, before
    // the brief reads at 4:30. The comprehensive, repair-capable counterpart to the
    // 60s in-process health-monitor (which only checks): runs every doctor invariant
    // with fix:true so safe issues self-heal (WAL checkpoint, orphaned integration
    // rows) instead of accumulating between the infrequent daemon restarts.
    name: 'doctor.run',
    cron: '15 4 * * *',
    description: 'Daily health check + auto-repair (runs all invariants with --fix)',
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
    // MAX THROUGHPUT for backlog drain: 30 sessions/tick, batch 5, every minute.
    // The scheduler won't fire the next tick while the current one is running
    // (cron is idempotent), so ticks that overrun just push the next one.
    // Revert to 5/3/*/5 once the backlog clears.
    await runBiographer(db, llm, 30, {
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
  daemon.registerHandler('doctor.run', async () => {
    // Comprehensive daily health check + auto-repair (fix:true). Shares the exact
    // invariant set with `robin doctor` via buildDoctorInvariants so the two can't
    // drift. Operates on the daemon's shared db; never closes it.
    const userData = resolveUserDataDir();
    const reports = await runInvariants(buildDoctorInvariants(db, userData), { fix: true });
    const log = createLogger({ module: 'doctor' });
    const repaired = reports.filter((r) => r.repaired);
    const warn = reports.filter((r) => !r.ok && r.severity !== 'critical');
    const fail = reports.filter((r) => !r.ok && r.severity === 'critical');
    const summary =
      `daily doctor: ${reports.filter((r) => r.ok).length}/${reports.length} ok` +
      (repaired.length ? `, ${repaired.length} auto-repaired` : '') +
      (warn.length ? `, ${warn.length} warn` : '') +
      (fail.length ? `, ${fail.length} FAIL` : '');
    const names = {
      repaired: repaired.map((r) => r.name),
      warn: warn.map((r) => r.name),
      fail: fail.map((r) => r.name),
    };
    if (fail.length) log.error(names, summary);
    else if (warn.length || repaired.length) log.warn(names, summary);
    else log.info(summary);
  });
  for (const job of COGNITION_JOBS) {
    scheduleCronJob(db, { name: job.name, cron: job.cron });
  }
}
