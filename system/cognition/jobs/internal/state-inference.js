// state-inference.js — heartbeat-paced internal job that produces
// kind='state_inference' memos per active source.
//
// Cognition D1 spec §1, §5. This file contains the per-source pipeline
// (composeForSource), the active-source loop entry point
// (evaluateStateInference), and two pure helpers (computeSignalHash,
// detectChange) that are unit-tested in isolation.

import { sha256 } from '../../../data/embed/hash.js';

/**
 * Stable hash over the inputs that define "what is the user working on?":
 *   - sorted entity record-ref strings
 *   - String(arc_id ?? null)
 *   - String(last_event_id ?? null)
 *
 * Sorting makes the hash insensitive to attention-lens ordering jitter.
 *
 * @param {{ entities: (string|object)[], arc_id?: string|null, last_event_id?: string|null }} inputs
 * @returns {string} hex SHA-256
 */
export function computeSignalHash({ entities = [], arc_id = null, last_event_id = null } = {}) {
  const ents = entities
    .map((e) => (e == null ? '' : String(e)))
    .filter((s) => s.length > 0)
    .sort();
  const payload = JSON.stringify({
    entities: ents,
    arc_id: arc_id == null ? null : String(arc_id),
    last_event_id: last_event_id == null ? null : String(last_event_id),
  });
  return sha256(payload);
}

/**
 * Decide whether the current snapshot differs materially from the prior
 * inference. Returns { materially_changed, signal_hash, reason } where
 * reason ∈ { 'no_prior', 'hash_differs', 'refresh_window', 'unchanged' }.
 *
 * Spec §1.3 step 5.
 *
 * @param {{
 *   prior: { meta?: { signal_hash?: string, last_active_at?: string|Date } } | null,
 *   current: { entities: (string|object)[], arc_id?: string|null, last_event_id?: string|null },
 *   now?: Date,
 *   refreshAfterMinutes?: number,
 * }} args
 */
export function detectChange({ prior, current, now = new Date(), refreshAfterMinutes = 30 }) {
  const signal_hash = computeSignalHash(current);
  if (!prior) {
    return { materially_changed: true, signal_hash, reason: 'no_prior' };
  }
  const priorHash = prior?.meta?.signal_hash ?? '';
  if (priorHash && priorHash !== signal_hash) {
    return { materially_changed: true, signal_hash, reason: 'hash_differs' };
  }
  const priorActive = prior?.meta?.last_active_at;
  if (priorActive) {
    const t = priorActive instanceof Date ? priorActive : new Date(priorActive);
    if (Number.isFinite(t.getTime())) {
      const ageMs = now.getTime() - t.getTime();
      if (ageMs > refreshAfterMinutes * 60_000) {
        return { materially_changed: true, signal_hash, reason: 'refresh_window' };
      }
    }
  }
  return { materially_changed: false, signal_hash, reason: 'unchanged' };
}

export const STATE_INFERENCE_SYSTEM = `You produce a one-sentence statement of what the user is currently working on, based on recent activity. Stay grounded in the evidence; do not speculate beyond what the inputs support. Output strict JSON.`;

export function buildPrompt({ arc, entities, events, prior }) {
  const entityLines = (entities ?? [])
    .slice(0, 10)
    .map((e) => `${e.type ?? 'unknown'}/${e.name ?? '?'}`)
    .join(', ');
  const eventLines = (events ?? [])
    .slice(0, 5)
    .map((e) => `- [${e.ts}] ${String(e.content ?? '').slice(0, 120)}`)
    .join('\n');
  return [
    `Active arc: ${arc?.summary ?? 'none'}`,
    `Recent entities: ${entityLines || 'none'}`,
    `Recent events (latest first):`,
    eventLines || '- (none)',
    `Prior inference (for context, may be stale): ${prior?.content ?? 'none'}`,
    ``,
    `Respond JSON only:`,
    `{ "focus_statement": string,`,
    `  "confidence": number,`,
    `  "evidence_snippet": string,`,
    `  "ambiguous": boolean,`,
    `  "drop": boolean }`,
  ].join('\n');
}

export function clampConfidence(c, ambiguous) {
  let v = typeof c === 'number' && Number.isFinite(c) ? c : 0.5;
  if (ambiguous) v = v * 0.5;
  if (v < 0.05) v = 0.05;
  if (v > 0.95) v = 0.95;
  return v;
}

export function validateLLMOutput(o) {
  if (!o || typeof o !== 'object') return { ok: false, error: 'not_object' };
  if (typeof o.focus_statement !== 'string') return { ok: false, error: 'missing_focus_statement' };
  if (typeof o.confidence !== 'number') return { ok: false, error: 'missing_confidence' };
  if (typeof o.ambiguous !== 'boolean') return { ok: false, error: 'missing_ambiguous' };
  if (typeof o.drop !== 'boolean') return { ok: false, error: 'missing_drop' };
  return { ok: true };
}
