// edge-registry.js — EDGE_KIND_REGISTRY + endpoint validation + canonical
// ordering + composite-ID helpers.
//
// Spec §5.3 + §6.1. The `edges.kind` schema field is OPEN; this registry is
// the in-code source of truth. Endpoint-type safety, self-loop rejection, and
// symmetric-edge canonicalization all happen here so callers of `store.relate`
// can't forget.

export const EDGE_KIND_REGISTRY = {
  mentions: { from: ['events', 'memos'], to: ['entities'] },
  about: { from: ['events', 'memos'], to: ['entities'] },
  before: { from: ['events'], to: ['events'] },
  works_on: { from: ['entities'], to: ['entities'] },
  participates_in: { from: ['entities'], to: ['entities', 'episodes'] },
  occurs_with: {
    from: ['entities'],
    to: ['entities'],
    symmetric: true,
    counter: true,
  },
  derived_from: {
    from: ['memos'],
    to: ['events', 'episodes', 'memos', 'entities'],
  },
  supersedes: { from: ['memos'], to: ['memos'] },
  contradicts: { from: ['memos'], to: ['memos'], symmetric: true },
};

/**
 * Extract the table name from a SurrealDB record reference.
 * Accepts either an object `{ tb, id }` (the SDK's RecordId shape) or a string
 * `"table:id"`.
 */
export function recordTable(ref) {
  if (!ref) return null;
  if (typeof ref === 'string') {
    const idx = ref.indexOf(':');
    return idx > 0 ? ref.slice(0, idx) : ref;
  }
  const t = ref.table ?? ref.tb;
  return t == null ? null : String(t);
}

export function recordStringId(ref) {
  if (!ref) return null;
  if (typeof ref === 'string') return ref;
  const tb = ref.table ?? ref.tb;
  if (tb && ref.id !== undefined) {
    const id = typeof ref.id === 'string' ? ref.id : String(ref.id);
    return `${String(tb)}:${id}`;
  }
  return null;
}

/**
 * Validate an edge before it touches the DB.
 * Checks: kind exists in registry; from/to tables are allowed; no self-loops.
 * Returns `{ ok: true }` or `{ ok: false, errors: [...] }`.
 */
export function validateEdge(from, to, kind) {
  const spec = EDGE_KIND_REGISTRY[kind];
  const errors = [];
  if (!spec) {
    errors.push(`unknown edge kind: ${kind}`);
    return { ok: false, errors };
  }
  const fromTb = recordTable(from);
  const toTb = recordTable(to);
  if (!fromTb) errors.push('from: missing or invalid record ref');
  if (!toTb) errors.push('to: missing or invalid record ref');
  if (fromTb && !spec.from.includes(fromTb)) {
    errors.push(`kind '${kind}' from must be one of [${spec.from.join(', ')}], got ${fromTb}`);
  }
  if (toTb && !spec.to.includes(toTb)) {
    errors.push(`kind '${kind}' to must be one of [${spec.to.join(', ')}], got ${toTb}`);
  }
  // Self-loop rejection: same record on both sides for any kind.
  const fromId = recordStringId(from);
  const toId = recordStringId(to);
  if (fromId && toId && fromId === toId) {
    errors.push(`self-loop rejected: from === to (${fromId})`);
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

/**
 * For symmetric edge kinds, return `[low, high]` ordered canonically by
 * `tb:id` string comparison. For asymmetric kinds, returns the inputs as-is.
 */
export function canonicalEndpoints(from, to, kind) {
  const spec = EDGE_KIND_REGISTRY[kind];
  if (!spec?.symmetric) return [from, to];
  const fromId = recordStringId(from);
  const toId = recordStringId(to);
  return fromId <= toId ? [from, to] : [to, from];
}

/**
 * Compose the deterministic record ID for an edge.
 * Returns a SurrealQL literal: `edges:[<kind>, <from>, <to>]`.
 * For symmetric kinds, callers should pass canonicalized endpoints first.
 */
export function compositeEdgeId(kind, from, to) {
  const f = recordStringId(from);
  const t = recordStringId(to);
  if (!f || !t) throw new Error('compositeEdgeId: invalid record refs');
  return { kind, from: f, to: t };
}

export function isCounterKind(kind) {
  return EDGE_KIND_REGISTRY[kind]?.counter === true;
}

export function isSymmetricKind(kind) {
  return EDGE_KIND_REGISTRY[kind]?.symmetric === true;
}
