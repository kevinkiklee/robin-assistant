// evidence.js — append-only ledger of corroborations and refutations.
// Confidence is derived (lazily) from this via fn::derived_confidence.
// Theme 2a.

import { BoundQuery, surql } from 'surrealdb';

export async function addEvidence(db, opts) {
  const { memo_id, polarity, reason, weight = 1.0, source_event, source_memo, meta } = opts;
  if (polarity !== 'corroborates' && polarity !== 'refutes') {
    throw new Error(`addEvidence: bad polarity '${polarity}'`);
  }
  if (!memo_id) throw new Error('addEvidence: memo_id required');
  if (!reason) throw new Error('addEvidence: reason required');
  const row = { memo_id, polarity, reason, weight };
  if (source_event != null) row.source_event = source_event;
  if (source_memo != null) row.source_memo = source_memo;
  if (meta != null) row.meta = meta;
  await db.query(surql`CREATE evidence_ledger CONTENT ${row}`).collect();
}

export async function evidenceFor(db, memo_id) {
  const [rows] = await db
    .query(
      new BoundQuery(`SELECT * FROM evidence_ledger WHERE memo_id = $id ORDER BY ts ASC`, {
        id: memo_id,
      }),
    )
    .collect();
  return rows ?? [];
}

export async function recomputeConfidence(db, memo_id) {
  const [rows] = await db
    .query(
      new BoundQuery(`SELECT VALUE fn::derived_confidence($id) FROM ONLY $id`, { id: memo_id }),
    )
    .collect();
  const c = rows?.[0];
  if (c == null) return null;
  await db
    .query(
      new BoundQuery(`UPDATE $id SET confidence = $c, meta.evidence_recomputed_at = time::now()`, {
        id: memo_id,
        c,
      }),
    )
    .collect();
  return c;
}

export async function readEvidenceConfig(db) {
  try {
    const [rows] = await db.query('SELECT VALUE value FROM runtime:`evidence.config`').collect();
    return rows?.[0] ?? { prior_weight: 3.0, biographer_weight: 0.5, manual_weight: 2.0 };
  } catch {
    return { prior_weight: 3.0, biographer_weight: 0.5, manual_weight: 2.0 };
  }
}
