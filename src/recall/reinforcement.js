// reinforcement.js — the recall-feedback loop.
//
// Phase 3 batching: 200 pending rows × (1 correction + N hit-updates + 1
// outcome update) collapses from ~1200 queries to ~7 by:
//   1. One pre-fetch for all correction events in the union window.
//   2. Bucket memo reinforcements by hit-count (preserves the "memo hit in
//      N pending rows → signal_count += N" semantics).
//   3. One UPDATE per outcome bucket on recall_log.

import { BoundQuery, surql } from 'surrealdb';

const REINFORCE_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

function hitRecordId(hit) {
  // Tolerate legacy field names; the canonical field is `record`.
  const v = hit.record ?? hit.memo_id ?? hit.event_id ?? hit.record_id;
  if (!v) return null;
  return typeof v === 'string' ? v : String(v);
}

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

  // Phase 3 step 1: one pre-fetch for ALL correction events in the union
  // window. Index `events_meta_kind` (added in Phase 1) keeps this O(log n).
  let minStart = Number.POSITIVE_INFINITY;
  let maxEnd = Number.NEGATIVE_INFINITY;
  for (const row of pending) {
    const ts = (row.ts instanceof Date ? row.ts : new Date(row.ts)).getTime();
    if (ts < minStart) minStart = ts;
    const end = ts + REINFORCE_WINDOW_MS;
    if (end > maxEnd) maxEnd = end;
  }
  const [corrections] = await db
    .query(
      surql`SELECT ts, meta.session_id AS sid
            FROM events
            WHERE meta.kind = 'correction'
              AND ts >= ${new Date(minStart)}
              AND ts <= ${new Date(maxEnd)}`,
    )
    .collect();

  // Bucket corrections by session id (null for global-session corrections).
  const correctionsBySession = new Map();
  for (const c of corrections ?? []) {
    const ts = (c.ts instanceof Date ? c.ts : new Date(c.ts)).getTime();
    const key = c.sid ?? '__null__';
    if (!correctionsBySession.has(key)) correctionsBySession.set(key, []);
    correctionsBySession.get(key).push(ts);
  }
  const hasCorrectionInWindow = (sessionId, tsStart, tsEnd) => {
    const buckets = sessionId
      ? [correctionsBySession.get(sessionId), correctionsBySession.get('__null__')]
      : Array.from(correctionsBySession.values());
    for (const b of buckets) {
      if (!b) continue;
      for (const t of b) {
        if (t >= tsStart && t <= tsEnd) return true;
      }
    }
    return false;
  };

  // Categorise pending rows + build the reinforcement count map.
  // We keep the record-ref form of `row.id` (not stringified) so the bucketed
  // `WHERE id IN $ids` UPDATE can match by record identity.
  const outcomesByRow = []; // [{ id: <record>, outcome }]
  const memoHitCount = new Map(); // "memos:X" -> times-recalled-in-window
  for (const row of pending) {
    summary.evaluated += 1;
    const tsStart = (row.ts instanceof Date ? row.ts : new Date(row.ts)).getTime();
    const tsEnd = tsStart + REINFORCE_WINDOW_MS;
    if (hasCorrectionInWindow(row.session_id, tsStart, tsEnd)) {
      outcomesByRow.push({ id: row.id, outcome: 'corrected' });
      summary.corrected += 1;
    } else if (!row.ranked_hits || row.ranked_hits.length === 0) {
      outcomesByRow.push({ id: row.id, outcome: 'evaluated_no_signal' });
      summary.no_signal += 1;
    } else {
      for (const hit of row.ranked_hits) {
        const id = hitRecordId(hit);
        if (!id?.startsWith('memos:')) continue;
        memoHitCount.set(id, (memoHitCount.get(id) ?? 0) + 1);
      }
      // A row with only event hits (no memo) still counts as reinforced: the
      // recall surfaced results that weren't subsequently corrected.
      outcomesByRow.push({ id: row.id, outcome: 'reinforced' });
      summary.reinforced += 1;
    }
  }

  // Theme 2a: emit refute ledger rows for memos in corrected rows.
  // Theme 3: emit a reflection trigger for each corrected row.
  const correctedMemoIds = new Set();
  const correctedRowIds = [];
  for (const row of pending) {
    const ob = outcomesByRow.find((o) => String(o.id) === String(row.id));
    if (ob?.outcome !== 'corrected') continue;
    correctedRowIds.push(row.id);
    for (const hit of row.ranked_hits ?? []) {
      const id = hitRecordId(hit);
      if (!id?.startsWith('memos:')) continue;
      correctedMemoIds.add(id);
    }
  }
  for (const rid of correctedRowIds) {
    try {
      await db
        .query(
          new BoundQuery(
            `CREATE dream_triggers CONTENT { step: 'reflection', reason: 'correction_landed', source_id: $sid }`,
            { sid: rid },
          ),
        )
        .collect();
    } catch (e) {
      console.warn(`[reinforce] trigger emit failed: ${e.message}`);
    }
  }
  for (const idStr of correctedMemoIds) {
    try {
      await db
        .query(
          new BoundQuery(
            `CREATE evidence_ledger CONTENT {
              memo_id: type::record('memos', $key),
              polarity: 'refutes',
              reason: 'correction',
              weight: 1.0
            }`,
            { key: idStr.slice('memos:'.length) },
          ),
        )
        .collect();
    } catch (e) {
      if (!String(e?.message ?? '').includes('does not exist')) {
        console.warn(`[reinforce] evidence-refute failed for ${idStr}: ${e.message}`);
      }
    }
  }

  // Theme 2a: emit corroborates ledger rows (one per hit, weight=N).
  for (const [idStr, n] of memoHitCount.entries()) {
    try {
      await db
        .query(
          new BoundQuery(
            `CREATE evidence_ledger CONTENT {
              memo_id: type::record('memos', $key),
              polarity: 'corroborates',
              reason: 'reinforcement',
              weight: $w
            }`,
            { key: idStr.slice('memos:'.length), w: n },
          ),
        )
        .collect();
    } catch (e) {
      if (!String(e?.message ?? '').includes('does not exist')) {
        console.warn(`[reinforce] evidence-corroborate failed for ${idStr}: ${e.message}`);
      }
    }
  }

  // Phase 3 step 2: bucket memo updates by count. One UPDATE per distinct count.
  // Memos recalled in N pending rows get signal_count += N (regression guard
  // gate 12 in scripts/verify-design-assumptions.js).
  const byCount = new Map(); // count -> array of memo:id strings
  for (const [id, n] of memoHitCount.entries()) {
    if (!byCount.has(n)) byCount.set(n, []);
    byCount.get(n).push(id);
  }
  for (const [n, ids] of byCount.entries()) {
    try {
      // Use array::map(...) server-side to build record refs from the string
      // keys, then UPDATE WHERE id IN that set. One round-trip per bucket.
      await db
        .query(
          new BoundQuery(
            `UPDATE memos
             SET signal_count += $n, decay_anchor = time::now()
             WHERE id IN $ids.map(|$s| type::record('memos', $s.slice($prefix.len())))`,
            { n, ids, prefix: 'memos:' },
          ),
        )
        .collect();
    } catch (e) {
      // Silent "does not exist" is expected (memo could have been deleted);
      // anything else is a real error worth surfacing.
      if (!String(e?.message ?? '').includes('does not exist')) {
        console.warn(`[reinforce] batch update failed (count=${n}): ${e.message}`);
      }
    }
  }

  // Phase 3 step 3: one UPDATE per outcome bucket on recall_log.
  const idsByOutcome = { reinforced: [], corrected: [], evaluated_no_signal: [] };
  for (const r of outcomesByRow) idsByOutcome[r.outcome].push(r.id);
  for (const outcome of Object.keys(idsByOutcome)) {
    if (idsByOutcome[outcome].length === 0) continue;
    try {
      await db
        .query(
          new BoundQuery(
            `UPDATE recall_log SET outcome = $o, evaluated_at = time::now()
             WHERE id IN $ids`,
            { o: outcome, ids: idsByOutcome[outcome] },
          ),
        )
        .collect();
    } catch (e) {
      console.warn(`[reinforce] outcome update failed (${outcome}): ${e.message}`);
    }
  }

  return summary;
}
