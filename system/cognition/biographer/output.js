// biographer-output.js — validates the JSON shape the biographer LLM returns.
import { mergeTrust } from '../discretion/wrap-untrusted.js';
//
// Edge vocabulary accepts both the new EDGE_KIND_REGISTRY names and the
// legacy aliases (co_occurs_with, precedes) so existing prompts keep working
// while the prompt template is updated. The biographer translates aliases
// when emitting edges via `store.relateAll`.

// Extract the largest balanced `{...}` substring starting at `startIdx`,
// respecting JSON string boundaries so a `}` inside a string doesn't close
// the outer object early. Returns the slice or null if unbalanced (likely
// truncated by a max_tokens cap mid-stream).
function extractBalancedObject(s, startIdx) {
  let depth = 0;
  let inString = false;
  let escapeNext = false;
  for (let i = startIdx; i < s.length; i++) {
    const ch = s[i];
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (inString) {
      if (ch === '\\') escapeNext = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return s.slice(startIdx, i + 1);
    }
  }
  return null;
}

// Parses the model's raw text content into a JSON object. Chat models in
// "fast tier" routinely wrap output in prose ("Here's the JSON:"), fence
// it with ```json fences anywhere in the response, or stop mid-stream when
// a max_tokens cap is hit. We try, in order:
//   1. fenced ```json ... ``` block (anywhere in content)
//   2. strip a leading/trailing fence pair and parse
//   3. direct JSON.parse on the trimmed string
//   4. balanced-brace extraction starting at the first `{`
// Throws with a category-specific message so the caller can tell empty /
// truncated / no-JSON apart from a malformed-but-present object.
export function parseLLMJSON(content) {
  const s = String(content ?? '').trim();
  if (s.length === 0) {
    throw new Error('parseLLMJSON: empty content (model returned no body)');
  }

  // Prefer fenced ```json ... ``` blocks since chat models default to them.
  // Non-greedy match captures content between paired fences; if multiple
  // fenced blocks exist, the longest match wins so prefatory reasoning fences
  // can't shadow the real JSON block.
  const fencedRe = /```(?:json)?\s*\n?([\s\S]*?)\n?```/gi;
  const fences = [...s.matchAll(fencedRe)].map((m) => m[1].trim()).filter((b) => b.length > 0);
  for (const block of fences.sort((a, b) => b.length - a.length)) {
    try {
      return JSON.parse(block);
    } catch {
      // try the next candidate
    }
  }

  // Strip a leading ```json fence + trailing ``` even when the closing
  // fence is missing (truncation) or contains stray whitespace. Cheap
  // fallback that catches "fence regex didn't match" cases — observed in
  // biographer.log as `Unexpected token '\`'` failures.
  if (s.startsWith('```')) {
    const stripped = s
      .replace(/^```(?:json)?\s*\n?/i, '')
      .replace(/```\s*$/, '')
      .trim();
    if (stripped.length > 0 && stripped !== s) {
      try {
        return JSON.parse(stripped);
      } catch {
        // fall through
      }
    }
  }

  // No fences (or none parsed). Try direct parse — happy path for clean output.
  try {
    return JSON.parse(s);
  } catch {
    // fall through to balanced-brace extraction
  }

  const firstBrace = s.indexOf('{');
  if (firstBrace === -1) {
    throw new Error('parseLLMJSON: no JSON object found in content');
  }
  const candidate = extractBalancedObject(s, firstBrace);
  if (candidate == null) {
    throw new Error('parseLLMJSON: unterminated JSON object (likely truncated by max_tokens cap)');
  }
  return JSON.parse(candidate);
}

/**
 * Server-side trust attribution. The LLM's source_event_ids[] can only cite
 * events present in the input batch — citations to non-batch ids are dropped
 * and we fall back to mergeTrust over the full batch (worst-case taint).
 */
export function applyDerivedTrust(records, batchEvents) {
  const batchById = new Map(batchEvents.map(e => [String(e.id), e.trust ?? 'trusted']));
  const fallback = mergeTrust(batchEvents.map(e => e.trust ?? 'trusted'));
  return records.map(r => {
    const cited = (r.source_event_ids ?? [])
      .map(id => batchById.get(String(id)))
      .filter(Boolean);
    const derived = cited.length > 0 ? mergeTrust(cited) : fallback;
    return { ...r, derived_from_trust: derived };
  });
}

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

// Coerce off-vocabulary entity types to `thing`. The LLM regularly proposes
// `service`, `organization`, `event` — all reasonable but outside the
// registered taxonomy. Demoting to `thing` keeps the row, drops only the
// off-vocab signal. The alternative (rejecting the whole batch) loses
// dozens of valid entities for one stray field.
function coerceEntityType(t) {
  if (ENTITY_TYPES.has(t)) return t;
  return 'thing';
}

// Coerce off-vocabulary edge types to null, signalling "drop this edge".
// Common stray kinds the LLM emits: `uses`, `created_by`, `located_in`.
// Mapping each to a registry kind is brittle; safer to drop and let the
// model's `mentions`/`about`/`occurs_with` cover the relationship.
function coerceEdgeType(t) {
  if (EDGE_TYPES.has(t)) return t;
  return null;
}

// Validate and coerce the biographer LLM's output. Hard-fails only on
// structural problems we can't recover from (not an object, scalar fields
// of the wrong type). For per-element issues — invalid entity type, edge
// pointing at a non-existent entity, edge with stray vocab — we drop the
// offending row and continue, surfacing a `warnings` array so callers can
// log the partial loss. This raises end-to-end batch success substantially
// without inviting bad data into the graph.
export function validateBiographerOutput(o) {
  if (!o || typeof o !== 'object') return { ok: false, error: 'output must be an object' };

  // Tolerate null/undefined for `entities` — model occasionally returns
  // `"entities": null` when nothing is detected. Treat as empty array.
  if (o.entities == null) o.entities = [];
  if (!Array.isArray(o.entities)) return { ok: false, error: 'output.entities must be an array' };

  const warnings = [];
  const cleanedEntities = [];
  for (const e of o.entities) {
    if (typeof e?.name !== 'string' || e.name.length === 0) {
      warnings.push('entity dropped: missing or empty name');
      continue;
    }
    const original = e.type;
    const coerced = coerceEntityType(e.type);
    if (coerced !== original) {
      warnings.push(`entity "${e.name}": type "${original}" → "thing"`);
    }
    cleanedEntities.push({ ...e, type: coerced });
  }
  o.entities = cleanedEntities;

  if (o.edges == null) o.edges = [];
  if (!Array.isArray(o.edges)) return { ok: false, error: 'output.edges must be an array' };

  const known = new Set(cleanedEntities.map((e) => e.name));
  const cleanedEdges = [];
  for (const ed of o.edges) {
    const kind = coerceEdgeType(ed?.type);
    if (!kind) {
      warnings.push(`edge dropped: type "${ed?.type}" not in vocabulary`);
      continue;
    }
    if (!known.has(ed.from)) {
      warnings.push(`edge dropped: from "${ed.from}" not in entities`);
      continue;
    }
    if (!known.has(ed.to)) {
      warnings.push(`edge dropped: to "${ed.to}" not in entities`);
      continue;
    }
    cleanedEdges.push({ ...ed, type: kind });
  }
  o.edges = cleanedEdges;

  if (o.about == null) o.about = [];
  if (!Array.isArray(o.about)) return { ok: false, error: 'output.about must be an array' };

  if (typeof o.episode_continues_previous !== 'boolean') {
    // Some prompts return null/undefined; default to false rather than
    // failing the batch. The episode-continuation signal is best-effort.
    o.episode_continues_previous = false;
    warnings.push('episode_continues_previous coerced to false');
  }

  return warnings.length > 0 ? { ok: true, warnings } : { ok: true };
}
