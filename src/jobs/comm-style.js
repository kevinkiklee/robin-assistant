// src/jobs/comm-style.js
import { surql } from 'surrealdb';

export const DEFAULTS = {
  tone: 'balanced',
  formality: 'balanced',
  emoji_ok: false,
  direct_feedback_ok: true,
  code_comment_density: 'minimal',
  summary_style: 'mixed',
};

const TONE_VALUES = new Set(['terse', 'balanced', 'verbose']);
const FORMALITY_VALUES = new Set(['casual', 'balanced', 'formal']);
const DENSITY_VALUES = new Set(['minimal', 'moderate', 'verbose']);
const SUMMARY_VALUES = new Set(['bullets', 'prose', 'mixed']);

export function validateCommStyleShape(obj) {
  if (!obj || typeof obj !== 'object') return { ok: false, reason: 'not_object' };
  if (!TONE_VALUES.has(obj.tone)) return { ok: false, reason: `bad tone: ${obj.tone}` };
  if (!FORMALITY_VALUES.has(obj.formality))
    return { ok: false, reason: `bad formality: ${obj.formality}` };
  if (typeof obj.emoji_ok !== 'boolean') return { ok: false, reason: 'emoji_ok not boolean' };
  if (typeof obj.direct_feedback_ok !== 'boolean')
    return { ok: false, reason: 'direct_feedback_ok not boolean' };
  if (!DENSITY_VALUES.has(obj.code_comment_density))
    return { ok: false, reason: `bad code_comment_density: ${obj.code_comment_density}` };
  if (!SUMMARY_VALUES.has(obj.summary_style))
    return { ok: false, reason: `bad summary_style: ${obj.summary_style}` };
  if (typeof obj.confidence !== 'number' || obj.confidence < 0 || obj.confidence > 1)
    return { ok: false, reason: `confidence out of range: ${obj.confidence}` };
  return { ok: true, value: obj };
}

export async function getCommStyle(db) {
  const [rows] = await db.query(surql`SELECT comm_style FROM profile:singleton`).collect();
  const cs = rows?.[0]?.comm_style ?? null;
  if (!cs) return null;
  // SurrealDB returns datetimes as objects with toDate(); normalize.
  if (cs.last_synthesized_at && typeof cs.last_synthesized_at.toDate === 'function') {
    cs.last_synthesized_at = cs.last_synthesized_at.toDate();
  } else if (typeof cs.last_synthesized_at === 'string') {
    cs.last_synthesized_at = new Date(cs.last_synthesized_at);
  }
  return cs;
}

export async function setCommStyle(db, fields) {
  const persisted = {
    tone: fields.tone,
    formality: fields.formality,
    emoji_ok: fields.emoji_ok,
    direct_feedback_ok: fields.direct_feedback_ok,
    code_comment_density: fields.code_comment_density,
    summary_style: fields.summary_style,
    evidence: Array.isArray(fields.evidence) ? fields.evidence : [],
    confidence: typeof fields.confidence === 'number' ? fields.confidence : 0,
    last_synthesized_at: new Date(),
  };
  await db.query(surql`UPSERT profile:singleton MERGE ${{ comm_style: persisted }}`).collect();
}
