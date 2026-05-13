import { RecordId } from 'surrealdb';

// edge-registry.js — EDGE_KIND_REGISTRY + endpoint validation + canonical
// ordering + composite-ID helpers.
//
// Spec: 2026-05-11-surrealdb-improvements-design.md (section 1) — edges live
// in a SurrealDB v3 TYPE RELATION table with `in`/`out` magic fields; the
// `edges.kind` discriminator stays open-enum. Registry-side validation gives
// us endpoint-type safety, self-loop rejection, and symmetric-edge
// canonicalization without forcing per-kind RELATION tables (the open-enum
// trade-off).
//
// Public function signatures (validateEdge/canonicalEndpoints) keep the
// `from`/`to` names for caller readability; the schema-level fields are
// `in`/`out` (and registry keys mirror that).

export const EDGE_KIND_REGISTRY = {
  mentions: { in: ['events', 'memos'], out: ['entities'] },
  about: { in: ['events', 'memos'], out: ['entities'] },
  before: { in: ['events'], out: ['events'] },
  works_on: { in: ['entities'], out: ['entities'] },
  participates_in: { in: ['entities'], out: ['entities', 'episodes'] },
  occurs_with: {
    in: ['entities'],
    out: ['entities'],
    symmetric: true,
    counter: true,
  },
  derived_from: {
    in: ['memos'],
    out: ['events', 'episodes', 'memos', 'entities'],
  },
  supersedes: { in: ['memos'], out: ['memos'] },
  contradicts: { in: ['memos'], out: ['memos'], symmetric: true },
  // arc_contains: arc -> episode membership. Replaces the legacy
  // `meta.episode_ids` array tracked on arcs (still written as a defensive
  // mirror for back-compat).
  arc_contains: { in: ['arcs'], out: ['episodes'] },
};

/**
 * Extract the table name from a SurrealDB record reference.
 * Accepts either an object `{ tb, id }` (the SDK's RecordId shape) or a string
 * `"table:id"`.
 */
function recordTable(ref) {
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
 * Inverse of `recordStringId`: parse a "table:id" string into a RecordId
 * object the SDK can bind correctly in a `surql` template.
 *
 * Why this matters: when `surql\`SELECT * FROM ${stringId}\`` is given a
 * plain JS string, SurrealDB v3 binds it as a string literal — so
 * `FROM "events:foo"` ends up iterating the characters of the string and
 * returning an array-shaped row with numeric keys, not the events row.
 *
 * Pass-through for non-strings so this helper is safe to wrap any id.
 */
export function recordIdFromString(ref) {
  if (ref == null) return ref;
  if (typeof ref !== 'string') return ref;
  const idx = ref.indexOf(':');
  if (idx <= 0) throw new Error(`recordIdFromString: malformed record id '${ref}'`);
  return new RecordId(ref.slice(0, idx), ref.slice(idx + 1));
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
  if (fromTb && !spec.in.includes(fromTb)) {
    errors.push(`kind '${kind}' from must be one of [${spec.in.join(', ')}], got ${fromTb}`);
  }
  if (toTb && !spec.out.includes(toTb)) {
    errors.push(`kind '${kind}' to must be one of [${spec.out.join(', ')}], got ${toTb}`);
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

export function isCounterKind(kind) {
  return EDGE_KIND_REGISTRY[kind]?.counter === true;
}
