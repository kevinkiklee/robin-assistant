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

// ---------------------------------------------------------------------------
// Synthesis
// ---------------------------------------------------------------------------

const RECENCY_MS = 30 * 86_400_000;
const MIN_SIGNALS = 3;
const SIGNAL_CAP = 100;

function buildPrompt(corrections) {
  const numbered = corrections.map((c, i) => `${i + 1}. ${c.content}`).join('\n');
  return `You are inferring a user's communication-style preferences from their recent corrections to an AI assistant.

Recent corrections (last 30 days, newest first):
${numbered}

Respond with strict JSON only:

{
  "tone": "terse" | "balanced" | "verbose",
  "formality": "casual" | "balanced" | "formal",
  "emoji_ok": boolean,
  "direct_feedback_ok": boolean,
  "code_comment_density": "minimal" | "moderate" | "verbose",
  "summary_style": "bullets" | "prose" | "mixed",
  "confidence": <float 0..1, how confident are you?>,
  "evidence_indices": <[int], 1-indexed indices of corrections that most informed this>
}

If a field has no signal, pick "balanced" (or false for booleans). No commentary, no markdown fences.`;
}

export async function synthesizeCommStyle(db, host) {
  const cutoff = new Date(Date.now() - RECENCY_MS);
  const [rows] = await db
    .query(
      surql`SELECT id, content, ts FROM events
            WHERE meta.kind = 'correction' AND ts > ${cutoff}
            ORDER BY ts DESC LIMIT ${SIGNAL_CAP}`,
    )
    .collect();
  const corrections = rows ?? [];

  if (corrections.length < MIN_SIGNALS) {
    await setCommStyle(db, { ...DEFAULTS, evidence: [], confidence: 0 });
    return { ok: true, comm_style: { ...DEFAULTS, confidence: 0 }, signals_used: corrections.length };
  }

  if (!host?.invokeLLM) return { ok: false, reason: 'no_host' };

  let parsed;
  try {
    const llm = await host.invokeLLM(
      [{ role: 'user', content: buildPrompt(corrections) }],
      { tier: 'balanced' },
    );
    parsed = JSON.parse(llm?.content ?? '');
  } catch (e) {
    return { ok: false, reason: 'parse_failed', detail: e.message };
  }

  const v = validateCommStyleShape(parsed);
  if (!v.ok) return { ok: false, reason: `invalid_shape: ${v.reason}` };

  const evidenceIds = [];
  for (const idx of parsed.evidence_indices ?? []) {
    const n = Number.parseInt(idx, 10);
    if (Number.isInteger(n) && n >= 1 && n <= corrections.length) {
      evidenceIds.push(String(corrections[n - 1].id));
    }
  }

  await setCommStyle(db, { ...v.value, evidence: evidenceIds });
  return {
    ok: true,
    comm_style: { ...v.value, evidence: evidenceIds },
    signals_used: corrections.length,
  };
}
