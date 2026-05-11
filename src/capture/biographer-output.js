// biographer-output.js — validates the JSON shape the biographer LLM returns.
//
// Edge vocabulary accepts both the new EDGE_KIND_REGISTRY names and the
// legacy aliases (co_occurs_with, precedes) so existing prompts keep working
// while the prompt template is updated. The biographer translates aliases
// when emitting edges via `store.relateAll`.

const ENTITY_TYPES = new Set(['person', 'place', 'project', 'topic', 'thing']);
const EDGE_TYPES = new Set([
  // Current registry kinds the biographer is allowed to emit.
  'mentions',
  'about',
  'works_on',
  'participates_in',
  'occurs_with',
  'before',
  // Legacy aliases — accepted for backward compatibility, normalized in
  // biographer.js → normalizeEdgeKind() before they touch the DB.
  'co_occurs_with',
  'precedes',
]);

export function validateBiographerOutput(o) {
  if (!o || typeof o !== 'object') return { ok: false, error: 'output must be an object' };
  if (!Array.isArray(o.entities)) return { ok: false, error: 'output.entities must be an array' };
  for (const e of o.entities) {
    if (typeof e?.name !== 'string' || e.name.length === 0) {
      return { ok: false, error: 'entity.name must be non-empty string' };
    }
    if (!ENTITY_TYPES.has(e.type)) {
      return { ok: false, error: `entity.type "${e.type}" not in vocabulary` };
    }
  }
  if (!Array.isArray(o.edges)) return { ok: false, error: 'output.edges must be an array' };
  const known = new Set(o.entities.map((e) => e.name));
  for (const ed of o.edges) {
    if (!EDGE_TYPES.has(ed?.type)) {
      return { ok: false, error: `edge.type "${ed?.type}" not in vocabulary` };
    }
    if (!known.has(ed.from)) {
      return { ok: false, error: `edge from "${ed.from}" references unknown entity` };
    }
    if (!known.has(ed.to)) {
      return { ok: false, error: `edge to "${ed.to}" references unknown entity` };
    }
  }
  if (!Array.isArray(o.about)) return { ok: false, error: 'output.about must be an array' };
  if (typeof o.episode_continues_previous !== 'boolean') {
    return { ok: false, error: 'episode_continues_previous must be boolean' };
  }
  // Theme 2a: optional evidence_signals[]. Biographer LLM may judge that the
  // new event corroborates or refutes an existing memo.
  if (o.evidence_signals !== undefined) {
    if (!Array.isArray(o.evidence_signals)) {
      return { ok: false, error: 'evidence_signals must be an array' };
    }
    for (const s of o.evidence_signals) {
      if (typeof s?.memo_id !== 'string' || s.memo_id.length === 0) {
        return { ok: false, error: 'evidence_signal.memo_id must be non-empty string' };
      }
      if (s.polarity !== 'corroborates' && s.polarity !== 'refutes') {
        return { ok: false, error: `evidence_signal.polarity must be corroborates|refutes` };
      }
    }
  }
  return { ok: true };
}
