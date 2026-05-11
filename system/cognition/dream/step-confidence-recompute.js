// step-confidence-recompute.js — Theme 2a. Lazy update of stored
// memos.confidence for memos with recent evidence_ledger activity.
//
// Runs nightly inside the dream pipeline after step-reflection. Reads
// fn::derived_confidence per affected memo; writes back the stored value
// + meta.evidence_recomputed_at marker. Fail-soft per step convention.

import { surql } from 'surrealdb';

export async function dreamStepConfidenceRecompute(db) {
  const summary = { updated: 0, errors: [] };

  let stale = [];
  try {
    const [rows] = await db
      .query(surql`SELECT VALUE memo_id FROM evidence_ledger GROUP BY memo_id`)
      .collect();
    stale = rows ?? [];
  } catch (e) {
    summary.errors.push(`stale-fetch: ${e.message}`);
    return summary;
  }

  for (const memoId of stale) {
    try {
      const [marker] = await db
        .query(surql`SELECT meta.evidence_recomputed_at AS r FROM ONLY ${memoId}`)
        .collect();
      const recomputedAt = marker?.[0]?.r;
      const [latest] = await db
        .query(
          surql`SELECT ts FROM evidence_ledger WHERE memo_id = ${memoId} ORDER BY ts DESC LIMIT 1`,
        )
        .collect();
      const latestTs = latest?.[0]?.ts;
      if (recomputedAt && latestTs && new Date(latestTs) <= new Date(recomputedAt)) continue;

      const [c] = await db
        .query(surql`SELECT VALUE fn::derived_confidence(${memoId}) FROM ONLY ${memoId}`)
        .collect();
      const newC = c?.[0];
      if (newC == null) continue;
      await db
        .query(
          surql`UPDATE ${memoId} SET confidence = ${newC}, meta.evidence_recomputed_at = time::now()`,
        )
        .collect();
      summary.updated += 1;
    } catch (e) {
      summary.errors.push(`memo ${String(memoId)}: ${e.message}`);
    }
  }

  return summary;
}
