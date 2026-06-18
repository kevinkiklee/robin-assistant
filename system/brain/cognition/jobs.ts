import { buildDoctorInvariants } from '../../kernel/invariants/doctor-set.ts';
import { runInvariants } from '../../kernel/invariants/runner.ts';
import type { Daemon } from '../../kernel/runtime/daemon.ts';
import { scheduleCronJob } from '../../kernel/scheduler/cron.ts';
import { createLogger } from '../../lib/logging/logger.ts';
import { resolveUserDataDir } from '../../lib/paths.ts';
import type { LLMDispatcher } from '../llm/dispatcher.ts';
import type { RobinDb } from '../memory/db.ts';
import { runBehaviorReinforce, runBehaviorSynthesize } from './behavior/index.ts';
import { runBiographer } from './biographer.ts';
import { runDream } from './dream.ts';
import { runEmbedder } from './embedder.ts';
import { ingestContentDocs } from './ingest-docs.ts';
import { runRecommendationLinker, runRecommendationScan } from './recommendations/index.ts';

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
  {
    // 3:40am — Tier A behavioral reinforcement (deterministic, free, no LLM). Slotted
    // BEFORE the 3:50 dream / 4:00 dream-synthesis / 4:15 doctor / 4:30 brief stack so
    // it never collides with them (it advances its own signal cursor and is cheap).
    // Recomputes habit confidence from state, retires stale habits, applies
    // high-precision exact-entity reinforcement, and stages new signals for Tier B.
    name: 'behavior-reinforce.run',
    cron: '40 3 * * *',
    description:
      'Nightly behavioral habit reinforcement (Tier A, deterministic): recompute confidence + retire stale + exact-entity reinforce + stage signals',
  },
  {
    // 3:45am — Recommendation→Action Loop linker (deterministic, free, no LLM). Slotted
    // in the 3:45 gap between behavior-reinforce (3:40) and dream (3:50) so it never
    // collides with the nightly stack (3:40 / 3:50 / 4:00 / 4:15 / 4:30 / 5:00). It
    // resolves open recommendations against recent behavioral signals (high-precision
    // subject match), expires past-expiry recs, and emits behavior.recommendation_acted
    // events — which the 5:00 Sunday Tier B synthesis then generalizes.
    name: 'recommendation-link.run',
    cron: '45 3 * * *',
    description:
      'Nightly recommendation→action linker (deterministic): resolve open recommendations against behavioral signals (subject match) + expire past-expiry + emit recommendation_acted signals',
  },
  {
    // 5:00am Sunday — Tier B behavioral synthesis (weekly LLM pass, bounded budget).
    // Weekly (≈4 LLM passes/month) because habits change slowly; skips entirely when no
    // new staged signals. Slotted at 5:00 — AFTER the entire 3:40–4:30 nightly stack
    // (dream 3:50 / dream-synthesis 4:00 / doctor 4:15 / brief 4:30) — so this $-bounded
    // LLM pass never contends for budget/LLM with the morning brief, even on Sundays.
    name: 'behavior-synthesize.run',
    cron: '0 5 * * 0',
    description:
      'Weekly behavioral habit synthesis (Tier B, LLM): semantic attribution + new candidate habits + merges, with creation floor + dedup + retired-suppression',
  },
  {
    // 5:30am Sunday — Recommendation session-scan backfill (Phase 1.1, weekly LLM pass,
    // bounded budget). Slotted at 5:30 — AFTER the entire nightly stack AND after Tier B
    // (5:00 Sunday) — so it never collides with the 3:40/3:45/3:50/4:00/4:15/4:30 jobs or
    // the weekly Tier B synthesis. Re-reads recent captured sessions, recovers substantive
    // recommendations Robin made but never logged via `recommend`, and records them as
    // `open` so the nightly deterministic linker can later detect whether Kevin acted.
    name: 'recommendation-scan.run',
    cron: '30 5 * * 0',
    description:
      'Weekly recommendation session-scan backfill (Phase 1.1, LLM): recover unlogged recommendations Robin made from recent sessions → record as open recs (precision-first, budget-bounded, deduped)',
  },
];

/**
 * Register cognition handlers on the daemon and seed their cron schedules.
 *
 * `getDraftClaims` resolves the `biographer.draftClaims` policy at handler time
 * (so flipping policies.yaml takes effect without a daemon restart). Defaults to
 * `true` — the schema default — when the daemon does not supply one.
 *
 * `getDomainGating` resolves the `biographer.domainGating` policy at handler time
 * (so flipping policies.yaml takes effect without a daemon restart). Defaults to
 * `true` — the schema default — when the daemon does not supply one.
 *
 * `getBehavior` resolves the `behavior.*` policy (enabled + graduation thresholds) at
 * handler time, the SAME restart-free mechanism as `biographer.domainGating`. Defaults
 * to the schema defaults when the daemon does not supply one.
 *
 * `getRecommendations` resolves the `recommendations.*` policy (enabled + link window +
 * default expiry) at handler time, the SAME restart-free mechanism as `getBehavior`.
 * Defaults to the schema defaults when the daemon does not supply one.
 *
 * `getRecommendationScan` resolves the `recommendationScan.*` policy (enabled + window +
 * budget) for the weekly LLM backfill at handler time, the SAME restart-free mechanism.
 * Defaults to the schema defaults when the daemon does not supply one.
 */
export interface BehaviorPolicy {
  enabled: boolean;
  graduationSupport: number;
  graduationWeeks: number;
}

export interface RecommendationsPolicy {
  enabled: boolean;
  linkWindowDays: number;
  defaultExpiryDays: number;
}

export interface RecommendationScanPolicy {
  enabled: boolean;
  windowDays: number;
  budgetUsd: number;
}

export function registerCognitionJobs(
  daemon: Daemon,
  db: RobinDb,
  getLLM: () => LLMDispatcher | null | undefined,
  getDraftClaims: () => boolean = () => true,
  getDomainGating: () => boolean = () => true,
  getBehavior: () => BehaviorPolicy = () => ({
    enabled: true,
    graduationSupport: 4,
    graduationWeeks: 3,
  }),
  getRecommendations: () => RecommendationsPolicy = () => ({
    enabled: true,
    linkWindowDays: 60,
    defaultExpiryDays: 90,
  }),
  getRecommendationScan: () => RecommendationScanPolicy = () => ({
    enabled: true,
    windowDays: 14,
    budgetUsd: 1.0,
  }),
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
      domainGating: getDomainGating(),
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
    await runDream(db, llm, undefined, { domainGating: getDomainGating() });
  });
  daemon.registerHandler('behavior-reinforce.run', async () => {
    const { enabled } = getBehavior();
    await runBehaviorReinforce(db, { enabled });
  });
  daemon.registerHandler('behavior-synthesize.run', async () => {
    const llm = getLLM() ?? null;
    const { enabled, graduationSupport, graduationWeeks } = getBehavior();
    await runBehaviorSynthesize(db, llm, { enabled, graduationSupport, graduationWeeks });
  });
  daemon.registerHandler('recommendation-link.run', async () => {
    const { enabled, linkWindowDays, defaultExpiryDays } = getRecommendations();
    await runRecommendationLinker(db, { enabled, linkWindowDays, defaultExpiryDays });
  });
  daemon.registerHandler('recommendation-scan.run', async () => {
    const llm = getLLM() ?? null;
    const { enabled, windowDays, budgetUsd } = getRecommendationScan();
    await runRecommendationScan(db, llm, { enabled, windowDays, budgetUsd });
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
