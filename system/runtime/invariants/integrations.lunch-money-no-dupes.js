// integrations.lunch_money_no_dupes
//
// Catches the pending↔cleared duplicate class from the CLAUDE.md runbook.
// Prevention shipped (`lm-stable:<key>` external_id), but legacy rows may
// remain.

import { surql } from 'surrealdb';

export default {
  name: 'integrations.lunch_money_no_dupes',
  level: 'warn',
  surface: 'integrations',
  phase: 'integrations',
  description: 'No duplicate Lunch Money events share a Plaid transaction_id.',

  runWhen: {
    boot: { enabled: false },
    heartbeat: { enabled: true, cooldownMs: 60 * 60 * 1000 },
    doctor: { enabled: true },
    postInstall: { enabled: false },
  },

  async enabled(ctx) {
    if (!ctx?.db) return false;
    try {
      const [rows] = await ctx.db
        .query(surql`SELECT count() AS n FROM events WHERE source = 'lunch_money' LIMIT 1 GROUP ALL;`)
        .collect();
      return (rows?.[0]?.n ?? 0) > 0;
    } catch {
      return false;
    }
  },

  async check(ctx) {
    if (!ctx?.db) return { ok: false, error: 'no_db_handle' };
    try {
      const [rows] = await ctx.db
        .query(
          surql`SELECT plaid_metadata.transaction_id AS tx, count() AS n FROM events WHERE source = 'lunch_money' AND plaid_metadata.transaction_id != NONE GROUP BY tx HAVING n > 1;`,
        )
        .collect();
      const dupes = Array.isArray(rows) ? rows : [];
      if (dupes.length > 0) {
        return {
          ok: false,
          error: 'duplicate_transactions',
          evidence: { count: dupes.length, sample: dupes.slice(0, 5) },
        };
      }
      return { ok: true, evidence: { count: 0 } };
    } catch (e) {
      return { ok: false, error: `query_failed:${e.message}` };
    }
  },

  // Repair (legacy cleanup) is intentionally a separate manual step. The
  // dedup script (`user-data/scripts/dedupe-lunch-money.mjs`) lives outside
  // the package — invariant only surfaces and explains. See B-3.

  explain(lastResult) {
    const lines = [
      '### `integrations.lunch_money_no_dupes`',
      '',
      '**Symptom.** Daily brief double-counts financial transactions; same payee/amount appears twice in recall.',
      '',
      '**Cause.** Lunch Money mints a fresh `id` when a pending Plaid txn clears. Legacy rows captured before the `lm-stable:<key>` external_id strategy was deployed may still have pending+cleared pairs.',
      '',
      '**Fix.** Prevention is already in tree (`transactionToEvent` uses `plaid_metadata.transaction_id` or a `lm-stable:<key>` composite). For legacy rows, run `node user-data/scripts/dedupe-lunch-money.mjs`. After 30 days with zero firings, B-3 retires this invariant\'s repair half — the check stays as a regression canary.',
    ];
    if (lastResult?.evidence?.count) {
      lines.push('', `**Current dupes:** ${lastResult.evidence.count} transaction_ids appear in multiple rows.`);
    }
    return lines.join('\n');
  },
};
