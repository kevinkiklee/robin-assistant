// Shared validators for entity-id and edge-kind inputs reaching MCP tools.
//
// SurrealDB record IDs are interpolated into queries because record-typed
// columns (`edges.in`, `edges.out`) don't compare equal when the value is
// bound as a JS string — record-to-record needs the literal form. We make
// that safe by validating the id alphabet up front so the interpolated
// substring cannot smuggle SurrealQL.

const ID_SUFFIX_RE = /^[A-Za-z0-9_-]+$/;
const TABLE_PREFIX = 'entities:';

/**
 * Validate and normalize an entity reference string. Accepts either
 * `"entities:abc"` or the bare suffix `"abc"`. Throws on anything else.
 * Returns the canonical `entities:abc` form (safe to interpolate).
 */
export function validateEntityRef(input, argName = 'id') {
  if (typeof input !== 'string' || input.length === 0) {
    throw new Error(`${argName}: must be a non-empty string`);
  }
  const suffix = input.startsWith(TABLE_PREFIX) ? input.slice(TABLE_PREFIX.length) : input;
  if (suffix.length === 0 || suffix.length > 64 || !ID_SUFFIX_RE.test(suffix)) {
    throw new Error(`${argName}: invalid record id (allowed: ${ID_SUFFIX_RE.source})`);
  }
  return `${TABLE_PREFIX}${suffix}`;
}

/**
 * Validate an array of edge-kind strings against an allow-list. Throws on
 * any unknown kind. Returns the deduped input order.
 */
export function validateEdgeKinds(kinds, allowed) {
  if (!Array.isArray(kinds) || kinds.length === 0) {
    throw new Error('edge_kinds: must be a non-empty array');
  }
  const allowSet = new Set(allowed);
  const seen = new Set();
  const out = [];
  for (const k of kinds) {
    if (typeof k !== 'string' || !allowSet.has(k)) {
      throw new Error(`edge_kind: not allowed: ${String(k)}`);
    }
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}
