// db.pending_recall_log_bounded
//
// Reinforcement runs every 5 min and moves pending recall_log rows out of
// 'pending'. If too many old pending rows accumulate, the reinforcement
// pipeline is misbehaving or has been off.
//
// No repair — surfaces a real signal that warrants investigation.

import { surql } from 'surrealdb';

const STALE_PENDING_DAYS = 7;
const WARN_THRESHOLD = 100;

export default {
  name: 'db.pending_recall_log_bounded',
  level: 'warn',
  surface: 'db',
  phase: 'db',
  description: 'Pending recall_log rows older than 7 days are bounded (<=100).',

  runWhen: {
    boot: { enabled: false },
    heartbeat: { enabled: true, cooldownMs: 15 * 60 * 1000 },
    doctor: { enabled: true },
    postInstall: { enabled: false },
  },

  async check(ctx) {
    if (!ctx?.db) return { ok: false, error: 'no_db_handle' };
    try {
      const cutoff = new Date(Date.now() - STALE_PENDING_DAYS * 24 * 60 * 60 * 1000);
      const [rows] = await ctx.db
        .query(
          surql`SELECT count() AS n FROM recall_log WHERE outcome = 'pending' AND ts < ${cutoff} GROUP ALL;`,
        )
        .collect();
      const n = rows?.[0]?.n ?? 0;
      if (n > WARN_THRESHOLD) {
        return {
          ok: false,
          error: 'stale_pending_excessive',
          evidence: { count: n, threshold: WARN_THRESHOLD, cutoff: cutoff.toISOString() },
        };
      }
      return { ok: true, evidence: { count: n, threshold: WARN_THRESHOLD } };
    } catch (e) {
      return { ok: false, error: `query_failed:${e.message}` };
    }
  },

  explain(lastResult) {
    const lines = [
      '### `db.pending_recall_log_bounded`',
      '',
      "**Symptom.** `recall_log` table accumulates rows with `outcome='pending'` older than 7 days.",
      '',
      '**Cause.** The `reinforce-recall` internal job is not running, or is silently failing. Without it, recall hits never get attributed and `signal_count` never increments.',
      '',
      '**Fix.** Investigate. Common causes: scheduler bucket disabled; daemon was down for an extended period; recall_log rows wedged on a malformed payload. Manual triage — purging the rows or restarting reinforcement is destructive without context.',
    ];
    if (lastResult?.evidence?.count != null) {
      lines.push(
        '',
        `**Current evidence:** ${lastResult.evidence.count} pending rows older than 7d (threshold ${lastResult.evidence.threshold}).`,
      );
    }
    return lines.join('\n');
  },
};
