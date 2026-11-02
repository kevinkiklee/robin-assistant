import { gcStaleTerminalJobs } from '../../integrations/_runtime/gc.ts';
import { loadPolicies } from '../../kernel/config/load.ts';
import { DEFAULT_RETENTION_DAYS as JOBS_RETENTION_DAYS } from '../../kernel/invariants/builtins/jobs-history-bounded.ts';
import { buildDoctorInvariants } from '../../kernel/invariants/doctor-set.ts';
import { runInvariants } from '../../kernel/invariants/runner.ts';
import type { Invariant, InvariantReport } from '../../kernel/invariants/types.ts';
import {
  markRepairAttempted,
  recordAlert,
  resolveAlert,
} from '../../kernel/runtime/alert-store.ts';
import type { Daemon } from '../../kernel/runtime/daemon.ts';
import {
  currentSha,
  isRepairBroken,
  recordRepairFailure,
} from '../../kernel/runtime/repair-breaker.ts';
import { scheduleCronJob } from '../../kernel/scheduler/cron.ts';
import { readLandLog } from '../../lib/land-log.ts';
import { createLogger } from '../../lib/logging/logger.ts';
import { resolveUserDataDir } from '../../lib/paths.ts';
import { writeRemediationRequest } from '../../lib/remediation-request.ts';
import type { LLMDispatcher } from '../llm/dispatcher.ts';
import { compactCapturedSessions } from '../memory/compact-sessions.ts';
import type { RobinDb } from '../memory/db.ts';
import { runBehaviorReinforce, runBehaviorSynthesize } from './behavior/index.ts';
import { hasBiographerWork } from './biographer.ts';
import { spawnCognitionChild } from './detached.ts';
import { runEmbedder } from './embedder.ts';
import { ingestContentDocs, pruneDocEvents } from './ingest-docs.ts';
import { runRecallAudit } from './recall-audit.ts';
import { runRecommendationLinker, runRecommendationScan } from './recommendations/index.ts';
import { remediationGoal, runReliabilityAudit } from './reliability-audit.ts';
import { RETENTION_DAYS, runRetention } from './retention.ts';
import { SCOUT_CONFIGS } from './scouts/configs.ts';
import { runScout } from './scouts/engine.ts';

export interface CognitionJob {
  name: string;
  cron: string;
  description: string;
}

/**
 * Migration criterion (spec A, 2026-06-10): a handler belongs in
 * `COGNITION_CHILD_JOBS` (cognition-runner-entry.ts, dispatched via
 * spawnCognitionChild — a detached, process-isolated child) once its runtime
 * is LLM-scale — minutes, driven by provider latency and retries, with a real
 * chance of outrunning an in-process job's lease or blocking the sequential
 * scheduler loop long enough to trip the heartbeat invariant. biographer.run
 * and dream.run are there today. Everything below stays in-process: seconds-
 * scale, deterministic-or-bounded handlers (rollups, linkers, scouts, the
 * doctor's own invariant sweep) that finish fast enough to never threaten the
 * scheduler loop, so the isolation overhead of a separate process buys nothing.
 */
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
    // 4:00am — reliability step 4: judges whether the self-healing shipped in
    // steps 1-3 (alerts incident ladder, migration 036 + health-monitor.ts; the
    // repair breaker, repair-breaker.ts; the doctor-set fix map, doctor-set.ts)
    // actually worked, over the trailing day/week. Read-only except the one
    // outcome='recurred' mark. Slotted at 4:00 — clear of dream (3:50) and ahead
    // of doctor (4:15) and the 4:30 brief, which renders its date-stamped
    // artifact. In-process (deterministic, seconds-scale), same tier as doctor.run.
    name: 'reliability-audit.run',
    cron: '0 4 * * *',
    description:
      'Nightly reliability audit (deterministic): healed/recurred incidents, missed crons, stale integrations, agent runs without outcome, 7d per-invariant trends + circuit-broken + degradation flags — written to a date-stamped artifact',
  },
  {
    // 4:50am — daily file-retention sweep (deterministic, fs-only, seconds). Slotted
    // after the 3:40–4:30 nightly stack so it never races a writer of today's
    // dated artifacts. Deletes agent-runs/ files and dated state/runtime/
    // `<name>-YYYY-MM-DD.json` files older than RETENTION_DAYS (60).
    name: 'retention.run',
    cron: '50 4 * * *',
    description:
      'Daily retention sweep: agent-runs transcripts + dated state/runtime files older than 60 days; terminal job rows older than 7 days; compact captured sessions older than 90 days',
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
    // 5:00am on the 1st — monthly sampled recall audit (≤30 classify calls). Reads the
    // kept-set logs auto-recall records in recall_log.kept_json, judges whether the
    // injected memories were relevant and whether they influenced the session's answer,
    // and rolls the verdicts into metrics_daily (recall_precision / recall_utilization).
    // Slotted at 5:00 — clear of the entire 3:40–4:30 nightly stack; monthly cadence
    // means the rare 1st-falls-on-Sunday overlap with the 5:00 Tier B synthesis just
    // queues (scheduleCronJob is idempotent, ticks are sequential).
    name: 'recall-audit.run',
    cron: '0 5 1 * *',
    description:
      'Monthly sampled audit: were injected memories relevant, did they influence answers',
  },
  {
    // 5:30am Sunday — Recommendation session-scan backfill (Phase 1.1, weekly LLM pass,
    // bounded budget). Slotted at 5:30 — AFTER the entire nightly stack AND after Tier B
    // (5:00 Sunday) — so it never collides with the 3:40/3:45/3:50/4:00/4:15/4:30 jobs or
    // the weekly Tier B synthesis. Re-reads recent captured sessions, recovers substantive
    // recommendations Robin made but never logged via `recommend`, and records them as
    // `open` so the nightly deterministic linker can later detect whether the operator acted.
    name: 'recommendation-scan.run',
    cron: '30 5 * * 0',
    description:
      'Weekly recommendation session-scan backfill (Phase 1.1, LLM): recover unlogged recommendations Robin made from recent sessions → record as open recs (precision-first, budget-bounded, deduped)',
  },
  // 5:30am weekdays, one domain scout per day (value-loops plan 3) — staggered
  // Mon–Fri so at most ONE paid scout call fires per day, all clear of the
  // 3:40–5:00 nightly stack and off the 5:00/5:30 SUNDAY weekly slots (Tier B +
  // recommendation-scan). Each pass: freshness-check its sources, run the
  // deterministic digest, ONE structured 'reasoning' call, candidates through
  // applyRecommendGate. Kill-switches: policies.scouts.enabled + policies.scouts.<id>.
  {
    name: 'scout-finance.run',
    cron: '30 5 * * 1',
    description:
      'Weekly finance scout (Mon): lunch_money transactions + balances → gated rec candidates',
  },
  {
    name: 'scout-travel.run',
    cron: '30 5 * * 2',
    description:
      'Weekly travel scout (Tue): next-30d calendar + season context → gated rec candidates',
  },
  {
    name: 'scout-health.run',
    cron: '30 5 * * 3',
    description:
      'Weekly health scout (Wed): whoop recovery/sleep/workout aggregates → gated rec candidates',
  },
  {
    name: 'scout-career.run',
    cron: '30 5 * * 4',
    description:
      'Weekly career scout (Thu): gmail subjects by sender-domain (never bodies) → gated rec candidates',
  },
  {
    name: 'scout-social.run',
    cron: '30 5 * * 5',
    description:
      'Weekly social scout (Fri): next-30d calendar + photowalk listings → gated rec candidates',
  },
  {
    // 5:30am Saturday — entity hygiene (weekly LLM pass, bounded: ≤12 candidate
    // groups in 2 `classify` calls, ≤10 merges). Saturday 5:30 is the one free
    // weekly slot: clear of the 3:40–4:30 nightly stack, the Mon–Fri scouts and the
    // Sunday 5:00/5:30 passes. Process-isolated like dream (COGNITION_CHILD_JOBS):
    // LLM-latency-scale. Merges are reversible from the entity.hygiene event's
    // snapshot; the backlog is cleared by hand with `robin entities hygiene --backlog`.
    name: 'entity-hygiene.run',
    cron: '30 5 * * 6',
    description:
      'Weekly entity hygiene (LLM): merge entities that are one thing under several names (lexical nomination → classify judge → mergeEntities + aliases)',
  },
];

/**
 * Register cognition handlers on the daemon and seed their cron schedules.
 *
 * `_getDraftClaims`/`_getDomainGating` (positions 4 and 5) are UNUSED here as of
 * the biographer.run/dream.run process-isolation cutover: those two handlers now
 * dispatch to a detached child (spawnCognitionChild) that resolves
 * `biographer.draftClaims`/`biographer.domainGating` itself via loadPolicies at
 * run time (system/brain/cognition/cognition-runner-entry.ts's
 * COGNITION_CHILD_JOBS), the same restart-free mechanism these getters used to
 * provide in-process. Kept as parameters (underscore-prefixed so
 * noUnusedParameters doesn't fire) purely so `registerCognitionJobs`'s
 * signature — and every positional getter after them (getBehavior,
 * getRecommendations, getRecommendationScan) — doesn't shift for daemon.ts's
 * call site.
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

/**
 * Run `invariants` with `fix:true`, routing the repair decision and the
 * failing/ok results through the SAME incident ladder (alerts table, spec B)
 * health-monitor.ts's tick() drives — so a repair attempt is claimed at most
 * once per open incident whether the monitor or the doctor gets there first,
 * and a tripped repair-breaker skips the repair() call the same way in both
 * places. This is what gives doctor-only invariants (mcp.dist_current,
 * cognition.no_orphan_children, agent.worktrees_bounded — none of which the
 * 60s health-monitor ever checks) real incident rows for the first time: the
 * `recordAlert`/`resolveAlert` calls below are unconditional, not gated on
 * whether the invariant is also in the monitor's set.
 *
 * Ordering subtlety: `markRepairAttempted` only mutates an OPEN alert row.
 * For a doctor-only invariant's FIRST-EVER failure there is no row yet (the
 * monitor never opened one), so `beforeRepair` records the alert itself —
 * using `inv.symptom` as a placeholder message — BEFORE the once-per-incident
 * claim, giving `markRepairAttempted` something to land on. `recordAlert` is
 * idempotent per open (source,key) (refresh, not insert, once a row exists),
 * so the canonical recordAlert pass after the run below — with the live
 * check's own message — simply refines that placeholder in place.
 *
 * The monitor's own ladder path in health-monitor.ts is untouched; this is a
 * second, independent entry point onto the same `alerts` rows.
 */
export async function runDoctorInvariants(
  db: RobinDb,
  userData: string,
  invariants: Invariant[],
): Promise<InvariantReport[]> {
  const sha = currentSha();
  const reports = await runInvariants(invariants, {
    fix: true,
    beforeRepair: (inv) => {
      recordAlert(db, {
        severity: inv.severity === 'critical' ? 'critical' : 'warning',
        source: 'invariant',
        key: inv.name,
        message: inv.symptom,
      });
      // Mirrors health-monitor.ts's tick(): a tripped breaker still claims
      // the once-per-incident attempt (so a shared invariant's escalation
      // path isn't stalled at rung 0 waiting on repair_attempted_at) but
      // skips the actual repair() call that keeps failing.
      if (isRepairBroken(userData, inv.name, sha)) {
        markRepairAttempted(db, 'invariant', inv.name);
        return false;
      }
      return markRepairAttempted(db, 'invariant', inv.name);
    },
    onRepairError: (inv) => {
      recordRepairFailure(userData, inv.name, sha);
    },
  });

  // Alert-wire every result exactly as health-monitor's tick does (source=
  // 'invariant', key=name): failing → open/refresh, ok → resolve (crediting
  // outcome='repaired' automatically when a repair was attempted this run).
  for (const r of reports) {
    if (r.ok) {
      resolveAlert(db, 'invariant', r.name);
    } else {
      recordAlert(db, {
        severity: r.severity === 'critical' ? 'critical' : 'warning',
        source: 'invariant',
        key: r.name,
        message: r.message ?? 'invariant failed',
      });
    }
  }

  return reports;
}

export function registerCognitionJobs(
  daemon: Daemon,
  db: RobinDb,
  getLLM: () => LLMDispatcher | null | undefined,
  _getDraftClaims: () => boolean = () => true,
  _getDomainGating: () => boolean = () => true,
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
  // biographer.run / dream.run: process-isolated (spec A) — dispatched to a
  // detached child via spawnCognitionChild rather than run in-process. Tick
  // options, deadlines, and the steady-state-mode rationale now live with the
  // child's job spec: COGNITION_CHILD_JOBS in ./cognition-runner-entry.ts.
  // _getDraftClaims/_getDomainGating (above) are no longer read here for these
  // two jobs — the child resolves policies itself at run time.
  // The empty-queue gate. biographer.run is on `* * * * *` so a session captured
  // at any moment is extracted within the minute — but that cadence used to cost
  // a detached child process every tick regardless of whether anything was
  // pending, and the queue is empty on the overwhelming majority of ticks
  // (~1,440 spawns/day, most booting Node for ~125ms only to find no target and
  // exit ~14ms later). hasBiographerWork runs the selector's own predicate
  // in-process for ~11ms and skips the spawn when there is nothing to do.
  //
  // Returning undefined here takes the exact path an already-in-flight tick
  // takes when spawnCognitionChild returns 'skipped': the daemon completes the
  // job row and re-arms the cron normally. Latency is unchanged — a session
  // arriving just after a probe is picked up by the next tick 60s later, the
  // same bound as before — and the probe shares its SQL with the selector, so it
  // cannot under-report work the child would have found.
  daemon.registerHandler('biographer.run', (job) => {
    if (!hasBiographerWork(db)) return undefined;
    const r = spawnCognitionChild(db, job);
    return r === 'detached' ? 'detached' : undefined;
  });
  daemon.registerHandler('dream.run', (job) => {
    const r = spawnCognitionChild(db, job);
    return r === 'detached' ? 'detached' : undefined;
  });
  daemon.registerHandler('entity-hygiene.run', (job) => {
    const r = spawnCognitionChild(db, job);
    return r === 'detached' ? 'detached' : undefined;
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
  // runEmbedder reports failure in its RETURN VALUE, never by throwing: a missing
  // embed role, an unavailable provider, or a wholesale reindex error all come
  // back as status 'skipped'/'no-embed' with the reason in `message`. Discarding
  // that (the previous `await runEmbedder(db, llm)`) made a fully stalled
  // embedder indistinguishable from an idle one — every minute, silently, with
  // nothing in the log to notice. Only non-ok runs and partial failures are
  // logged; a healthy idle tick stays quiet so this stays a 1-line-per-minute
  // job at worst.
  daemon.registerHandler('embedder.run', async () => {
    const llm = getLLM() ?? null;
    const r = await runEmbedder(db, llm);
    if (r.status !== 'ok') {
      createLogger({ module: 'job:embedder' }).warn(
        { status: r.status, reason: r.message, eligible: r.total_eligible },
        'embedder: not running — backlog will not drain',
      );
    } else if (r.failed > 0) {
      createLogger({ module: 'job:embedder' }).warn(
        { embedded: r.embedded, failed: r.failed, eligible: r.total_eligible },
        'embedder: some rows failed to embed',
      );
    }
  });
  daemon.registerHandler('ingest-docs.run', () => {
    const llm = getLLM() ?? null;
    const userDataDir = resolveUserDataDir();
    const docs = ingestContentDocs(db, llm, { userDataDir });
    // Prune AFTER ingest: excluded or deleted files leave the recall index here —
    // Exclusion (excludedPrefixes) alone only stops future ingestion, so legacy events for
    // newly-excluded or deleted docs would otherwise linger forever.
    const { pruned } = pruneDocEvents(db, { userDataDir });
    if (docs.ingested || docs.updated || pruned) {
      createLogger({ module: 'ingest-docs' }).info(
        `ingest-docs: ${docs.ingested} ingested, ${docs.updated} updated, ${docs.skipped} skipped, ${pruned} pruned`,
      );
    }
  });
  daemon.registerHandler('recall-audit.run', async () => {
    const llm = getLLM() ?? null;
    const res = await runRecallAudit(db, llm);
    if (!res.skipped) {
      createLogger({ module: 'recall-audit' }).info(
        `recall-audit: ${res.sampled} sampled, ${res.judgedItems} judged items, ` +
          `precision=${res.precision === null ? 'n/a' : res.precision.toFixed(2)}, ` +
          `utilization=${res.utilization === null ? 'n/a' : res.utilization.toFixed(2)}`,
      );
    }
  });
  // Domain scouts (value-loops plan 3): one handler per config, mirroring the
  // recall-audit.run pattern (thin dispatch; the engine logs its own completion
  // line, including WHY a pass skipped). The scouts policy block is resolved at
  // handler time — the same restart-free discipline as the injected resolvers
  // above — so flipping policies.yaml silences a scout without a daemon restart.
  for (const config of SCOUT_CONFIGS) {
    daemon.registerHandler(`scout-${config.id}.run`, async () => {
      const scouts = loadPolicies(resolveUserDataDir()).scouts;
      await runScout(db, getLLM() ?? null, config, {
        enabled: scouts.enabled && scouts[config.id],
      });
    });
  }
  daemon.registerHandler('reliability-audit.run', () => {
    const userDataDir = resolveUserDataDir();
    const res = runReliabilityAudit(db, { userDataDir });
    const log = createLogger({ module: 'reliability-audit' });
    log.info(
      `reliability-audit: ${res.healed.length} healed, ${res.recurred.length} recurred, ` +
        `${res.needsHuman.length} needs-human, ${res.trends.flags.length} flags`,
    );
    // Auto-fix (2026-10-31): hand the findings to K. The agent runner's next tick
    // dispatches it ahead of the rotation; a verified fix auto-lands.
    const goal = remediationGoal(res, readLandLog(userDataDir, Date.now() - 7 * 86_400_000));
    if (goal) {
      writeRemediationRequest(userDataDir, {
        date: res.date,
        createdAt: new Date().toISOString(),
        goal,
      });
      log.info('reliability-audit: remediation request queued for K');
    }
  });
  daemon.registerHandler('retention.run', () => {
    // Captured sessions > 90 days: keep the operator's turns, drop assistant text (once each).
    const compacted = compactCapturedSessions(db, { apply: true });
    if (compacted.sessions > 0) {
      createLogger({ module: 'retention' }).info(
        compacted,
        `retention: compacted ${compacted.sessions} old captured sessions ` +
          `(${(compacted.bytesBefore / 1e6).toFixed(1)} → ${(compacted.bytesAfter / 1e6).toFixed(1)} MB)`,
      );
    }
    // Terminal job rows past the jobs.history_bounded window. Must run here, not
    // only as that invariant's repair(): repairs fire only once the 50k ceiling
    // trips, so rows otherwise pile up ~13 days at ~3.9k/day before every prune.
    const jobsPruned = gcStaleTerminalJobs(db, JOBS_RETENTION_DAYS);
    if (jobsPruned > 0) {
      createLogger({ module: 'retention' }).info(
        { jobsPruned },
        `retention: pruned ${jobsPruned} terminal job rows older than ${JOBS_RETENTION_DAYS}d`,
      );
    }
    const res = runRetention(resolveUserDataDir());
    if (res.agentRunsDeleted || res.runtimeDeleted || res.errors) {
      createLogger({ module: 'retention' }).info(
        res,
        `retention: deleted ${res.agentRunsDeleted} agent-runs files ` +
          `(${(res.agentRunsBytes / 1e6).toFixed(1)} MB) + ${res.runtimeDeleted} dated runtime files ` +
          `older than ${RETENTION_DAYS}d` +
          (res.errors ? `, ${res.errors} errors` : ''),
      );
    }
  });
  daemon.registerHandler('doctor.run', async () => {
    // Comprehensive daily health check + auto-repair (fix:true). Shares the exact
    // invariant set with `robin doctor` via buildDoctorInvariants so the two can't
    // drift. Operates on the daemon's shared db; never closes it. runDoctorInvariants
    // alert-wires the results onto the same incident ladder health-monitor.ts's tick
    // uses — see its doc comment for why and the ordering it depends on.
    const userData = resolveUserDataDir();
    const reports = await runDoctorInvariants(db, userData, buildDoctorInvariants(db, userData));
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
