// biographer-output.js — validates the JSON shape the biographer LLM returns.
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
  let escape = false;
  for (let i = startIdx; i < s.length; i++) {
    const ch = s[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (ch === '\\') escape = true;
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
//   2. direct JSON.parse on the trimmed string
//   3. balanced-brace extraction starting at the first `{`
// Throws with a category-specific message so the caller can tell empty /
// truncated / no-JSON apart from a malformed-but-present object.
export function parseLLMJSON(content) {
  const s = String(content ?? '').trim();
  if (s.length === 0) {
    throw new Error('parseLLMJSON: empty content (model returned no body)');
  }

  // Prefer fenced ```json ... ``` blocks since chat models default to them.
  // Greedy match keeps any inner ``` as part of the captured JSON; if multiple
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
  return { ok: true };
}
