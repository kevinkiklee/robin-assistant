import { surql } from 'surrealdb';
import { updateCandidateStatus } from '../dream/candidates.js';
import { updateProfileFields } from './persona.js';

/**
 * rules — durable instructions Robin should follow, derived from approved
 * `rule_candidates`. Every approved candidate (regardless of kind) writes a
 * row here so we keep an append-only history that can be replayed/audited.
 *
 * Side-effects on approval (per kind):
 *   - `behavior`           → rules row only
 *   - `profile_update`     → applies `payload.fields` to profile:singleton
 *                            AND writes a rules row (replayability)
 *   - `conflict_warning`   → narrows kind to `behavior` for the rules row
 *
 * Order matters: read the candidate first (so `kind` and `payload` are
 * authoritative), apply the profile mutation, create the rules row, THEN flip
 * the candidate to `approved`. Flipping first risks losing the source values
 * if anything in between fails.
 */
export async function approveCandidate(db, candidateId) {
  const idRef = String(candidateId).startsWith('rule_candidates:')
    ? String(candidateId)
    : `rule_candidates:${candidateId}`;
  const idKey = idRef.replace('rule_candidates:', '');

  const [rows] = await db
    .query(surql`SELECT * FROM type::record('rule_candidates', ${idKey})`)
    .collect();
  const cand = rows[0];
  if (!cand) throw new Error(`candidate not found: ${candidateId}`);

  if (cand.kind === 'profile_update' && cand.payload?.fields) {
    await updateProfileFields(db, cand.payload.fields);
  }

  const ruleKind = cand.kind === 'conflict_warning' ? 'behavior' : cand.kind;
  const ruleFields = {
    content: cand.content,
    kind: ruleKind,
    source_candidate: cand.id,
    active: true,
    ...(cand.payload ? { payload: cand.payload } : {}),
  };
  const [created] = await db.query(surql`CREATE rules CONTENT ${ruleFields}`).collect();
  const ruleRow = Array.isArray(created) ? created[0] : created;

  await updateCandidateStatus(db, candidateId, 'approved');
  return { id: ruleRow.id };
}

export async function rejectCandidate(db, candidateId, reason) {
  await updateCandidateStatus(db, candidateId, 'rejected', reason);
}

export async function listRules(db, { activeOnly = true, limit = 100 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error(`listRules: limit out of range [1,1000]: ${limit}`);
  }
  const where = activeOnly ? 'WHERE active = true' : '';
  const sql = `SELECT id, content, kind, payload, priority, active, created_at, source_candidate FROM rules ${where} ORDER BY priority DESC, created_at DESC LIMIT ${limit}`;
  const [rows] = await db.query(sql).collect();
  return rows;
}

export async function deactivateRule(db, ruleId) {
  const idRef = String(ruleId).startsWith('rules:') ? String(ruleId) : `rules:${ruleId}`;
  const idKey = idRef.replace('rules:', '');
  await db
    .query(surql`UPDATE type::record('rules', ${idKey}) MERGE ${{ active: false }}`)
    .collect();
}

export async function setRulePriority(db, ruleId, priority) {
  if (!Number.isInteger(priority) || priority < 1 || priority > 100) {
    throw new Error(`priority must be int 1..100; got ${priority}`);
  }
  const idRef = String(ruleId).startsWith('rules:') ? String(ruleId) : `rules:${ruleId}`;
  const idKey = idRef.replace('rules:', '');
  await db.query(surql`UPDATE type::record('rules', ${idKey}) MERGE ${{ priority }}`).collect();
}
