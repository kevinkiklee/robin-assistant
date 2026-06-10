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
    // STEADY-STATE mode (2026-06-10), not backlog-drain. Earlier "max throughput"
    // settings (30 chunks/tick, 15-min deadline) assumed the backlog would clear
    // and the config would be reverted — but inflow is continuous (~1.5-4k
    // captured sessions/day from always-on Claude Code loops), so there is no
    // "after the backlog". Those 8-16-min ticks blocked the sequential scheduler
    // loop, tripped the 7-min heartbeat CRITICAL hundreds of times/day, and
    // outran the job lease on every single run (231/232 runs reaped mid-flight).
    //
    // Short ticks on the every-minute cron deliver the SAME chunks/hour — the
    // cron re-arms on completion, so throughput is cadence × budget, not tick
    // length (10 chunks/~3-min cycle ≈ the old 30 chunks/~13-min cycle). What
    // changes: the loop yields every few minutes (other jobs wait ≤~4 min, not
    // ≤16), normal ticks stay under the 7-min heartbeat ceiling, and heartbeat
    // CRITICAL once again means something is actually wrong.
    await runBiographer(db, llm, 30, {
      maxChunksPerTick: 10,
      batchChunks: 5,
      skipToolChunks: true,
      draftClaims: getDraftClaims(),
      // Stop claiming further sessions after 3 min — keeps a normal tick well
      // under the 7-min heartbeat ceiling (cursor persists; next cron resumes).
      // Worst case (provider down, every chunk hung to its 2-min timeout) is
      // still clipped by the scheduler's 20-min HANDLER_TIMEOUT_MS, which the
      // 25-min job lease deliberately exceeds.
      tickDeadlineMs: 3 * 60 * 1000,
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
