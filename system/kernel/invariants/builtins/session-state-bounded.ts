import type { RobinDb } from '../../../brain/memory/db.ts';
import { countSessionState, gcStaleSessionState } from '../../../integrations/_runtime/gc.ts';
import type { Invariant } from '../types.ts';

/** Repair keeps this many days of session-dedup rows. No Claude Code transcript
 *  is touched after it goes idle, so two weeks is a generous floor; a re-parse of
 *  a pruned-then-resurfaced session is harmless (dedup_hit catches it). */
const DEFAULT_RETENTION_DAYS = 14;
/** Warn above this many session-state rows. The capture scanner sees thousands of
 *  transcript files/week across all of ~/.claude/projects; 40k sits well above a
 *  healthy 14-day window yet far below the 126k unbounded runaway observed. */
const DEFAULT_WARN_ROWS = 40_000;

/**
 * The claude_code capture scanner records one `session:<project>:<id>` KV row per
 * transcript FILE it has ever seen (mtime dedup) and never prunes them, so
 * integration_state grows without bound (126k rows observed). Mirrors
 * `jobs.history_bounded`: warn above a ceiling; `repair()` (daily doctor /
 * `--fix`) drops session-dedup rows untouched past the retention window.
 * Thresholds are injectable so tests stay fast.
 */
export function sessionStateBoundedInvariant(
  db: RobinDb,
  opts: { warnRows?: number; retentionDays?: number } = {},
): Invariant {
  const warnRows = opts.warnRows ?? DEFAULT_WARN_ROWS;
  const retentionDays = opts.retentionDays ?? DEFAULT_RETENTION_DAYS;
  return {
    name: 'state.claude_code_session_bounded',
    severity: 'warning',
    symptom:
      'integration_state grows unboundedly: the capture scanner keeps one session-dedup row per transcript file ever seen.',
    cause:
      'claude_code session:* mtime-dedup rows are only ever upserted, never pruned. 126k rows accrued before a retention sweep existed.',
    fix: `Run \`robin doctor --fix\` (the daily doctor prunes session-state rows untouched for ${retentionDays} days).`,
    check: () => {
      const n = countSessionState(db);
      if (n <= warnRows) return { ok: true };
      return {
        ok: false,
        message: `${n} claude_code session-state rows (ceiling ${warnRows})`,
        remediation: 'robin doctor --fix',
      };
    },
    repair: () => {
      gcStaleSessionState(db, retentionDays);
    },
  };
}
