// reinforcement.js — the recall-feedback loop.
// Spec §6.4.
//
// For each pending recall_log row older than the reinforce window:
//   - Look for `meta.kind = 'correction'` events in the same session between
//     the recall ts and ts + window.
//   - If a correction landed: mark outcome='corrected'; no reinforcement.
//   - Else if no hits were returned: mark outcome='evaluated_no_signal'.
//   - Else for each hit memo: signal_count += 1 AND decay_anchor = now;
//     mark outcome='reinforced'.

import { BoundQuery, surql } from 'surrealdb';

export const REINFORCE_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Evaluate all pending recall_log rows whose ts < now - REINFORCE_WINDOW_MS.
 * Idempotent: only acts on rows with outcome='pending'.
 *
 * @returns {{ evaluated: number, reinforced: number, corrected: number, no_signal: number }}
 */
export async function evaluatePending(db) {
  const cutoff = new Date(Date.now() - REINFORCE_WINDOW_MS);
  const [pending] = await db
    .query(
      surql`SELECT id, session_id, ts, ranked_hits
            FROM recall_log
            WHERE outcome = 'pending' AND ts < ${cutoff}
            ORDER BY ts ASC
            LIMIT 200`,
    )
    .collect();

  const summary = { evaluated: 0, reinforced: 0, corrected: 0, no_signal: 0 };
  if (!pending || pending.length === 0) return summary;

  for (const row of pending) {
    summary.evaluated += 1;
    const tsStart = row.ts instanceof Date ? row.ts : new Date(row.ts);
    const tsEnd = new Date(tsStart.getTime() + REINFORCE_WINDOW_MS);

    // Did a correction event land in this session during the window?
    const correctionSql = `
      SELECT count() AS n FROM events
      WHERE meta.kind = 'correction'
        AND ts >= $start AND ts <= $end
        ${row.session_id ? 'AND meta.session_id = $sid' : ''}
      GROUP ALL
    `;
    const bindings = { start: tsStart, end: tsEnd };
    if (row.session_id) bindings.sid = row.session_id;
    const [correctionRows] = await db.query(new BoundQuery(correctionSql, bindings)).collect();
    const correctionCount = correctionRows?.[0]?.n ?? 0;

    let outcome;
    if (correctionCount > 0) {
      outcome = 'corrected';
      summary.corrected += 1;
    } else if (!row.ranked_hits || row.ranked_hits.length === 0) {
      outcome = 'evaluated_no_signal';
      summary.no_signal += 1;
    } else {
      // Reinforce each hit memo: signal_count += 1, decay_anchor = now.
      for (const hit of row.ranked_hits) {
        const hitId = hit.memo_id ?? hit.event_id ?? hit.record_id ?? hit.record;
        if (!hitId) continue;
        // We only reinforce memos (not raw events).
        const idStr = typeof hitId === 'string' ? hitId : String(hitId);
        if (!idStr.startsWith('memos:')) continue;
        const key = idStr.slice('memos:'.length);
        try {
          await db
            .query(
              `UPDATE type::record('memos', $key) SET signal_count += 1, decay_anchor = time::now()`,
              { key },
            )
            .collect();
        } catch (e) {
          // Memo deletion is expected; other errors (DB connection, schema)
          // are worth surfacing so silent signal loss doesn't hide regressions.
          if (!String(e?.message ?? '').includes('does not exist')) {
            console.warn(`[reinforce] memo update failed for ${idStr}: ${e.message}`);
          }
        }
      }
      outcome = 'reinforced';
      summary.reinforced += 1;
    }

    await db
      .query(surql`UPDATE ${row.id} SET outcome = ${outcome}, evaluated_at = time::now()`)
      .collect();
  }

  return summary;
}
