import * as child from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { surql } from 'surrealdb';
import { runEval } from '../../../cognition/intuition/eval.js';
import { ensureHome } from '../../../config/data-store.js';
import { close, connect, defaultDbUrl } from '../../../data/db/client.js';
import { createEmbedder } from '../../../data/embed/factory.js';
import { readProfile } from '../../../data/embed/profile-router.js';
import { parseArgs } from '../args.js';

const DEFAULT_WINDOW_DAYS = 30;
const DEFAULT_K = 6;
const DEFAULT_LIMIT = 5000;

function parseWindowDays(s) {
  if (!s) return DEFAULT_WINDOW_DAYS;
  const m = /^(\d+)d$/.exec(String(s));
  if (!m) throw new Error(`invalid --window: ${s} (expected e.g. 30d)`);
  return Number(m[1]);
}

function readThresholds(value) {
  return {
    min_rows: value?.min_rows ?? 100,
    precision_at_6_min: value?.precision_at_6_min ?? 0.2,
    ndcg_at_6_min: value?.ndcg_at_6_min ?? 0.35,
    no_signal_rate_max: value?.no_signal_rate_max ?? 0.3,
    mean_rank_of_neg_at_10_min: value?.mean_rank_of_neg_at_10_min ?? 4.0,
  };
}

function gitSha() {
  try {
    // execFileSync is the safe variant (no shell interpolation); args are static.
    return child
      .execFileSync('git', ['rev-parse', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

function formatPercent(n) {
  return `${(n * 100).toFixed(1)}%`;
}
function fmtK(metrics, prefix) {
  return [1, 3, 6, 10]
    .map((k) => `${(metrics[`${prefix}_at_${k}`] ?? 0).toFixed(3).padStart(7)}`)
    .join(' ');
}

function printText(out, run) {
  out(
    `Recall eval — profile=${run.profile} window=${run.window_start.toISOString().slice(0, 10)}..${run.window_end.toISOString().slice(0, 10)} source=${run.source_filter}`,
  );
  out(
    `  rows_scored=${run.rows_scored}  rows_pending=${run.rows_pending}  rows_skipped=${run.rows_skipped}`,
  );
  if ((run.rows_with_null_session_total ?? 0) > 0) {
    out(
      `  warning: ${run.rows_with_null_session_total} rows used session_id=NONE fallback (${run.rows_with_null_session_evaluated ?? 0} of those evaluated).`,
    );
  }
  out('');
  out(`  metric              k=1     k=3     k=6     k=10`);
  out(`  precision      ${fmtK(run.metrics, 'precision')}`);
  out(`  recall         ${fmtK(run.metrics, 'recall')}`);
  out(`  nDCG           ${fmtK(run.metrics, 'ndcg')}`);
  out(`  mean_rank_of_neg@10  ${(run.metrics.mean_rank_of_negatives_at_10 ?? 0).toFixed(2)}`);
  out(`  no_signal_rate       ${formatPercent(run.metrics.no_signal_rate ?? 0)}`);
}

export async function recallEval(argv) {
  const args = parseArgs(argv);
  const flags = args.flags ?? {};
  const json = flags.json === true;
  const replay = flags.replay === true;
  const limit = Number(flags.limit ?? DEFAULT_LIMIT);
  const windowDays = parseWindowDays(flags.window);
  const k = Number(flags.k ?? DEFAULT_K);
  const requestedProfile = typeof flags.profile === 'string' ? flags.profile : null;
  const source = typeof flags.source === 'string' ? flags.source : 'all';
  const outPath = typeof flags.out === 'string' ? flags.out : null;

  if (!['intuition', 'mcp_recall', 'all'].includes(source)) {
    process.stderr.write(`invalid --source: ${source}\n`);
    process.exit(3);
  }

  let db;
  try {
    await ensureHome();
    db = await connect({ engine: process.env.ROBIN_DB_URL ?? (await defaultDbUrl()) });
  } catch (e) {
    process.stderr.write(`recall-eval: db open failed: ${e.message}\n`);
    process.exit(3);
  }

  let exitCode = 0;
  try {
    const activeProfile = await readProfile(db).catch(() => null);
    if (!activeProfile) {
      process.stderr.write(`recall-eval: runtime:embedder.active_profile not set\n`);
      process.exit(3);
    }
    const profile = requestedProfile ?? activeProfile;
    if (replay && requestedProfile && requestedProfile !== activeProfile) {
      process.stderr.write(`recall-eval: --replay requires --profile=${activeProfile} (active)\n`);
      process.exit(3);
    }

    const [thrRows] = await db
      .query(surql`SELECT VALUE value FROM type::record('runtime', 'recall_eval.thresholds')`)
      .collect();
    const thresholds = readThresholds(thrRows?.[0]);

    const windowEnd = new Date();
    const windowStart = new Date(windowEnd.getTime() - windowDays * 86_400_000);

    let embedder = null;
    if (replay) {
      embedder = await createEmbedder({ db });
    }

    const ks = [...new Set([1, 3, 6, 10, k])].sort((a, b) => a - b);
    const result = await runEval({
      db,
      embedder,
      windowStart,
      windowEnd,
      profile,
      sourceFilter: source,
      replay,
      limit,
      ks,
    });

    // Fold non-SCHEMAFULL fields into `metrics` (FLEXIBLE).
    const enrichedMetrics = {
      ...result.metrics,
      by_focus_block: result.metrics_by_focus_block,
      replay_kendall_mean: result.replay_kendall_mean,
      rows_with_null_session_total: result.rows_with_null_session_total,
      rows_with_null_session_evaluated: result.rows_with_null_session_evaluated,
    };
    const runRow = {
      profile,
      window_start: windowStart,
      window_end: windowEnd,
      source_filter: source,
      replay,
      rows_scored: result.rows_scored,
      rows_pending: result.rows_pending,
      rows_skipped: result.rows_skipped,
      metrics: enrichedMetrics,
      per_source: result.per_source,
      config_digest: { ks, limit, thresholds },
      git_sha: gitSha(),
    };

    // Persist (best-effort).
    try {
      await db
        .query(
          surql`CREATE recall_eval_runs CONTENT ${{
            profile,
            window_start: windowStart,
            window_end: windowEnd,
            source_filter: source,
            replay,
            rows_scored: result.rows_scored,
            rows_pending: result.rows_pending,
            rows_skipped: result.rows_skipped,
            metrics: enrichedMetrics,
            per_source: result.per_source,
            config_digest: runRow.config_digest,
            git_sha: runRow.git_sha,
          }}`,
        )
        .collect();
    } catch (e) {
      process.stderr.write(`recall-eval: persist failed: ${e.message}\n`);
    }

    if (outPath) {
      writeFileSync(outPath, JSON.stringify(runRow, null, 2));
    }
    if (json) {
      process.stdout.write(`${JSON.stringify(runRow, null, 2)}\n`);
    } else {
      printText((s) => process.stdout.write(`${s}\n`), {
        profile,
        window_start: windowStart,
        window_end: windowEnd,
        source_filter: source,
        ...result,
      });
    }

    // Exit-code gating (spec §1.8).
    if (result.rows_scored < thresholds.min_rows) {
      exitCode = 1;
    } else {
      const breaches = [];
      if ((result.metrics.precision_at_6 ?? 0) < thresholds.precision_at_6_min)
        breaches.push('precision_at_6');
      if ((result.metrics.ndcg_at_6 ?? 0) < thresholds.ndcg_at_6_min) breaches.push('ndcg_at_6');
      if ((result.metrics.no_signal_rate ?? 0) > thresholds.no_signal_rate_max)
        breaches.push('no_signal_rate');
      const mrn = result.metrics.mean_rank_of_negatives_at_10;
      if (mrn != null && mrn < thresholds.mean_rank_of_neg_at_10_min)
        breaches.push('mean_rank_of_negatives_at_10');
      if (breaches.length > 0) {
        process.stderr.write(`recall-eval: threshold breach: ${breaches.join(', ')}\n`);
        exitCode = 2;
      }
    }
  } catch (e) {
    process.stderr.write(`recall-eval: ${e.message}\n`);
    exitCode = 3;
  } finally {
    try {
      await close(db);
    } catch {}
  }
  process.exit(exitCode);
}
