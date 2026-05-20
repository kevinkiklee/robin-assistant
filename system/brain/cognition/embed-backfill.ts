import { type ReindexReport, runReindexCore } from '../../surfaces/cli/reindex.ts';
import type { LLMDispatcher } from '../llm/dispatcher.ts';
import type { RobinDb } from '../memory/db.ts';

/**
 * Cognition job: pick up events_content rows whose embedding is NULL and embed them
 * in a bounded batch. Runs on cron from the scheduler (registerCognitionJobs).
 *
 * Why a batch ceiling: the daemon is meant to stay responsive — one cron tick should
 * not spin Ollama for an hour. 200 rows × ~600ms ≈ 2 minutes per tick on M5 Max with
 * qwen3-embedding:8b. Backlogs drain over multiple ticks; the cron is idempotent
 * (only one pending row per name) so ticks never overlap.
 *
 * Skips cleanly with `embed-backfill: no-embed-role` when models.yaml lacks an `embed`
 * role — same behavior as `robin reindex` would have on the CLI.
 */
export interface EmbedBackfillResult {
  status: 'ok' | 'skipped' | 'no-embed';
  embedded: number;
  failed: number;
  total_eligible: number;
  message?: string;
}

export const EMBED_BACKFILL_BATCH = 200;

export async function runEmbedBackfill(
  db: RobinDb,
  llm: LLMDispatcher | null,
  batch: number = EMBED_BACKFILL_BATCH,
): Promise<EmbedBackfillResult> {
  if (!llm) {
    return { status: 'no-embed', embedded: 0, failed: 0, total_eligible: 0, message: 'no LLM' };
  }
  let report: ReindexReport;
  try {
    report = await runReindexCore(db, llm, { limit: batch });
  } catch (err) {
    return {
      status: 'skipped',
      embedded: 0,
      failed: 0,
      total_eligible: 0,
      message: err instanceof Error ? err.message : String(err),
    };
  }
  if (report.errors.some((e) => e.includes('no embed role configured'))) {
    return {
      status: 'no-embed',
      embedded: 0,
      failed: 0,
      total_eligible: report.total_eligible,
      message: 'no embed role configured in models.yaml',
    };
  }
  return {
    status: 'ok',
    embedded: report.embedded,
    failed: report.failed,
    total_eligible: report.total_eligible,
  };
}
