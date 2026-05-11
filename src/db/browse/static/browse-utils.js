// Pure helpers shared by the browser inline script (loaded via
// /static/browse-utils.js) and by Node tests.
//
// Nothing in this file may touch the DOM, the network, the file system, or
// any Node-only API — it must run in both environments unchanged.

// Strip the leading `DEFINE FIELD <name> ON <table> ` prefix and the trailing
// `PERMISSIONS …` clause to leave a compact type signature.
export function compactFieldDef(def, name, table) {
  if (typeof def !== 'string') return '';
  const prefix = `DEFINE FIELD ${name} ON ${table} `;
  let s = def.startsWith(prefix) ? def.slice(prefix.length) : def;
  s = s.replace(/\s+PERMISSIONS\s+\w+$/i, '');
  return s;
}

// Hash-routed navigation helpers. The UI uses location.hash for stable URLs.
//
// Routes:
//   ''  / '#'                                 — no card (free-form querying)
//   '#editor'                                 — known anchor (skip-link); not a route
//   '#overview'                               — overview page card
//   '#table/<name>'                           — table card; name must match /^[a-z_][a-z0-9_]*$/i
//   '#saved/<group>/<label>'                  — saved-query card; label is URL-decoded

const TABLE_NAME_RE = /^[a-z_][a-z0-9_]*$/i;
const KNOWN_ANCHORS = new Set(['#editor']);

export function parseHash(hash) {
  if (!hash || hash === '#' || KNOWN_ANCHORS.has(hash)) return { kind: null };
  if (hash === '#overview') return { kind: 'overview' };
  let m = /^#table\/([^/]+)$/.exec(hash);
  if (m) {
    const name = m[1];
    if (!TABLE_NAME_RE.test(name)) return { kind: null };
    return { kind: 'table', name };
  }
  m = /^#saved\/([^/]+)\/(.+)$/.exec(hash);
  if (m) {
    let label;
    try {
      label = decodeURIComponent(m[2]);
    } catch {
      return { kind: null };
    }
    return { kind: 'saved', group: m[1], label };
  }
  return { kind: null };
}

export function hashFromState(state) {
  if (!state || !state.kind) return '#';
  if (state.kind === 'overview') return '#overview';
  if (state.kind === 'table') {
    return state.name ? `#table/${state.name}` : '#';
  }
  if (state.kind === 'saved') {
    if (!state.group || !state.label) return '#';
    return `#saved/${state.group}/${encodeURIComponent(state.label)}`;
  }
  return '#';
}

// Case-insensitive substring matcher used by sidebar search. Returns the
// matched range so the UI can highlight. Empty queries match everything but
// without a highlight range. Non-string haystack returns no match.
export function matchesQuery(text, q) {
  if (typeof q !== 'string' || q.trim() === '') return { match: true, range: null };
  if (typeof text !== 'string') return { match: false, range: null };
  const i = text.toLowerCase().indexOf(q.trim().toLowerCase());
  if (i < 0) return { match: false, range: null };
  return { match: true, range: [i, i + q.trim().length] };
}

// Detect a SurrealDB record-id literal of the form `<table>:<id>`. Returns
// { table, id } or null. Only the table-name segment is validated; the id
// can be anything after the first colon (covers compound IDs and ⟨…⟩ object
// IDs). Used by the result-table render to make record cells clickable.
const RECORD_RE = /^([a-z_][a-z0-9_]*):(.+)$/i;
export function detectRecordLink(value) {
  if (typeof value !== 'string') return null;
  const m = RECORD_RE.exec(value);
  if (!m) return null;
  return { table: m[1], id: m[2] };
}

// Sort comparator used by clickable result-column headers. Returns a
// negative number when `a` sorts before `b`, positive when after, 0 if
// equal. null/undefined always sort last (greater than everything),
// regardless of direction — the UI flips the result for descending,
// but the "null last" convention persists by sorting nulls separately
// at the call site or by reversing only non-null pairs.
export function compareValues(a, b) {
  const aNil = a == null;
  const bNil = b == null;
  if (aNil && bNil) return 0;
  if (aNil) return 1;
  if (bNil) return -1;
  const ta = typeof a;
  const tb = typeof b;
  if (ta !== tb) return 0;
  if (ta === 'number') return a - b;
  if (ta === 'boolean') return (a ? 1 : 0) - (b ? 1 : 0);
  if (ta === 'string') return a < b ? -1 : a > b ? 1 : 0;
  const sa = JSON.stringify(a);
  const sb = JSON.stringify(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

// Parse a filter input from the per-column filter row. Returns one of:
//   { kind: 'text', text: '<substring>' }
//   { kind: 'numeric', op: '>'|'<'|'='|'>='|'<=', value: number }
//   { kind: 'numeric', op: '..', min: number, max: number }
//   null  — empty input
//
// Backslash-prefix escapes the comparator detection: '\\>10' is the literal
// text '>10'. The caller decides whether to apply numeric matching based on
// the column's inferred type — this function just parses syntax.
const NUM_RANGE_RE = /^(-?\d+(?:\.\d+)?)\.\.(-?\d+(?:\.\d+)?)$/;
const NUM_OP_RE = /^(>=|<=|>|<|=)(-?\d+(?:\.\d+)?)$/;
export function parseFilterExpression(input) {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('\\')) return { kind: 'text', text: trimmed.slice(1) };
  const range = NUM_RANGE_RE.exec(trimmed);
  if (range) return { kind: 'numeric', op: '..', min: Number(range[1]), max: Number(range[2]) };
  const op = NUM_OP_RE.exec(trimmed);
  if (op) return { kind: 'numeric', op: op[1], value: Number(op[2]) };
  return { kind: 'text', text: trimmed };
}

// Append a new query to the history list, deduplicating by trimmed +
// whitespace-collapsed SQL. The most recent occurrence wins (older copies
// are removed before the new entry is appended). Caps the list at `max`
// entries, dropping oldest. Returns a NEW array — never mutates `prev`.
function normSql(s) {
  return typeof s === 'string' ? s.trim().replace(/\s+/g, ' ') : '';
}
export function dedupeHistory(prev, newSql, { max = 50 } = {}) {
  const norm = normSql(newSql);
  if (!norm) return Array.isArray(prev) ? prev : [];
  const arr = Array.isArray(prev) ? prev : [];
  const filtered = arr.filter((e) => normSql(e?.sql) !== norm);
  const out = [...filtered, { sql: newSql, ts: Date.now() }];
  if (out.length > max) out.splice(0, out.length - max);
  return out;
}

// Cursor-position-aware autocomplete trigger. Returns one of:
//   { kind: 'table', prefix: '<chars before cursor>' }
//   { kind: 'field', table: '<from-table>', prefix: '<chars before cursor>' }
//   null  — uncertain or empty
//
// Strategy: tokenize backward from `cursor` to find the identifier prefix
// (chars matching /[a-z0-9_]/i). Then look at the keyword preceding the
// prefix to decide context. For 'field' we additionally scan the WHOLE
// statement for a FROM clause and grab the table name.
const TABLE_TRIGGERS = ['from', 'into', 'table']; // INFO FOR TABLE x → 'table'
const FIELD_TRIGGERS = ['select', 'where', 'set', 'by', 'and', 'or', ','];
const IDENT_RE = /[a-z0-9_]/i;
const FROM_TABLE_RE = /\bfrom\s+`?([a-z_][a-z0-9_]*)`?/i;
export function parseAutocompleteContext(sql, cursor) {
  if (typeof sql !== 'string') return null;
  if (cursor < 0 || cursor > sql.length) return null;
  // Walk back to find the identifier prefix at cursor.
  let i = cursor;
  while (i > 0 && IDENT_RE.test(sql[i - 1])) i -= 1;
  const prefix = sql.slice(i, cursor);
  // Walk back from i over whitespace to find the prior token.
  let j = i;
  while (j > 0 && /\s/.test(sql[j - 1])) j -= 1;
  // Grab the prior token (sequence of identifier chars OR a single comma).
  let k = j;
  if (j > 0 && sql[j - 1] === ',') {
    k = j - 1;
  } else {
    while (k > 0 && IDENT_RE.test(sql[k - 1])) k -= 1;
  }
  const prior = sql.slice(k, j).toLowerCase();
  if (!prior) {
    const m = FROM_TABLE_RE.exec(sql);
    if (m) return { kind: 'field', table: m[1], prefix };
    return null;
  }
  if (TABLE_TRIGGERS.includes(prior)) return { kind: 'table', prefix };
  if (FIELD_TRIGGERS.includes(prior) || prior === ',') {
    const m = FROM_TABLE_RE.exec(sql);
    if (m) return { kind: 'field', table: m[1], prefix };
    return null;
  }
  return null;
}
