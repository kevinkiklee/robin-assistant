import { surql } from 'surrealdb';

/**
 * rule_candidates — proposals from the dream pipeline awaiting user review.
 *
 * Lifecycle: `pending` → `approved` | `rejected` | `expired`. Approval applies
 * side-effects (see `rules.js`); rejection records a reason for downstream
 * dedupe so the dream agent doesn't re-propose the same idea repeatedly.
 *
 * `signal_events` is `array<record<events>>` (SCHEMAFULL) — pass `[]` when no
 * events back the candidate yet.
 */
export async function createCandidate(db, input) {
  const { content, kind, signal_events, payload, confidence = 0.7, meta } = input;
  const fields = {
    content,
    kind,
    signal_events,
    confidence,
    status: 'pending',
    ...(payload ? { payload } : {}),
    ...(meta ? { meta } : {}),
  };
  const [created] = await db.query(surql`CREATE rule_candidates CONTENT ${fields}`).collect();
  const row = Array.isArray(created) ? created[0] : created;
  return { id: row.id };
}

export async function listCandidates(db, { status = 'pending', limit = 50 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error(`listCandidates: limit out of range [1,1000]: ${limit}`);
  }
  if (status !== 'all' && !['pending', 'approved', 'rejected', 'expired'].includes(status)) {
    throw new Error(`listCandidates: invalid status: ${status}`);
  }
  if (status === 'all') {
    const sql = `SELECT id, content, kind, payload, confidence, status, created_at, signal_events, rejected_reason FROM rule_candidates ORDER BY created_at DESC LIMIT ${limit}`;
    const [rows] = await db.query(sql).collect();
    return rows;
  }
  const sql = `SELECT id, content, kind, payload, confidence, status, created_at, signal_events, rejected_reason FROM rule_candidates WHERE status = $status ORDER BY created_at DESC LIMIT ${limit}`;
  const [rows] = await db.query(sql, { status }).collect();
  return rows;
}

export async function updateCandidateStatus(db, id, status, reason) {
  const idRef = String(id).startsWith('rule_candidates:') ? String(id) : `rule_candidates:${id}`;
  const idKey = idRef.replace('rule_candidates:', '');
  const fields = { status, reviewed_at: new Date() };
  if (reason) fields.rejected_reason = reason;
  await db.query(surql`UPDATE type::record('rule_candidates', ${idKey}) MERGE ${fields}`).collect();
}

/**
 * Returns the id of an existing pending/rejected candidate of `kind` whose
 * `signal_events` overlap `signalEventIds` by ≥ `overlapThreshold` (default
 * 0.5). Overlap denominator is the smaller-side cardinality, so a single
 * shared event between two singletons (1/1) and 2/4 vs 2/2 sets both register.
 *
 * Empty-on-either-side: `Math.max(1, ...)` avoids divide-by-zero, and the
 * intersection is necessarily 0, so an empty proposed or stored set never
 * fires a false positive.
 */
export async function findOverlappingPendingCandidate(
  db,
  kind,
  signalEventIds,
  overlapThreshold = 0.5,
) {
  const [rows] = await db
    .query(
      surql`SELECT id, signal_events FROM rule_candidates WHERE kind = ${kind} AND status IN ['pending', 'rejected']`,
    )
    .collect();
  const proposed = signalEventIds.map(String);
  for (const r of rows) {
    const existing = (r.signal_events ?? []).map(String);
    const intersection = existing.filter((id) => proposed.includes(id));
    const overlap = intersection.length / Math.max(1, Math.min(existing.length, proposed.length));
    if (overlap >= overlapThreshold) return r.id;
  }
  return null;
}

/**
 * For profile_update candidates only: returns the id of any existing
 * pending/rejected candidate whose `payload.fields` JSON-serialises identically
 * to `fields`. Used by the dream pipeline to skip re-proposing the same
 * profile change.
 */
export async function findIdenticalProfileCandidate(db, fields) {
  const [rows] = await db
    .query(
      surql`SELECT id, payload FROM rule_candidates WHERE kind = 'profile_update' AND status IN ['pending', 'rejected']`,
    )
    .collect();
  const target = JSON.stringify(fields);
  for (const r of rows) {
    if (JSON.stringify(r.payload?.fields ?? {}) === target) return r.id;
  }
  return null;
}
