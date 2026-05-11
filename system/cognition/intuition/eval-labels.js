// eval-labels.js — derive per-hit labels from a recall_log row + corrections.
//
// Per-hit label table (spec §1.3):
//   negative      : row.outcome='corrected' AND hit is memos:*
//   soft_positive : row.outcome='reinforced' AND hit is memos:*
//   unlabeled    : everything else (events, evaluated_no_signal, pending,
//                  non-memo hits)
//
// The function is pure: it takes the row + (unused-for-v1) correction array
// and emits an array of label objects, one per ranked_hits[] element. The
// correction array is plumbed in for future tightening (per-hit refute
// targeting once Theme 2a §12 lands) but is intentionally a no-op today.

function hitRecordIdString(hit) {
  const v = hit?.record ?? hit?.memo_id ?? hit?.event_id ?? hit?.record_id;
  if (v == null) return null;
  return typeof v === 'string' ? v : String(v);
}

/**
 * @param {{
 *   id: any, ts: any, session_id?: string,
 *   outcome: 'pending'|'reinforced'|'corrected'|'evaluated_no_signal',
 *   ranked_hits: Array<{ record: any, rank?: number }>
 * }} row
 * @param {Array<{ ts: any, sid?: string }>} _corrections
 *   Pre-fetched correction events in the recall row's 5-min window.
 *   Reserved for per-hit refute targeting (Theme 2a §12). Unused in v1.
 * @returns {Array<{ rank_index: number, record_id: string|null, label: 'negative'|'soft_positive'|'unlabeled' }>}
 */
export function labelHits(row, _corrections = []) {
  const hits = Array.isArray(row?.ranked_hits) ? row.ranked_hits : [];
  const outcome = row?.outcome ?? 'pending';
  return hits.map((hit, i) => {
    const recordId = hitRecordIdString(hit);
    const rankIndex = typeof hit?.rank === 'number' ? hit.rank : i;
    const isMemo = recordId?.startsWith('memos:') === true;
    let label = 'unlabeled';
    if (isMemo && outcome === 'corrected') label = 'negative';
    else if (isMemo && outcome === 'reinforced') label = 'soft_positive';
    return { rank_index: rankIndex, record_id: recordId, label };
  });
}
