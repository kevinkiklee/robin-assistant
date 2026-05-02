// Job-definition frontmatter parser.
// Extends the existing memory-index frontmatter parser with nested-object
// support (for `active:` window blocks) and array support.

const FM_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;
const INLINE_ARRAY_RE = /^\[(.*)\]$/;

function stripInlineComment(s) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (c === '#' && !inSingle && !inDouble) {
      return s.slice(0, i).trimEnd();
    }
  }
  return s;
}

function unquote(raw) {
  const t = raw.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return { value: t.slice(1, -1), quoted: true };
  }
  return { value: t, quoted: false };
}

function parseScalar(raw) {
  const stripped = stripInlineComment(raw);
  const { value: t, quoted } = unquote(stripped);
  if (quoted) return t;
  if (t === '') return '';
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null' || t === '~') return null;
  if (/^-?\d+$/.test(t)) return Number.parseInt(t, 10);
  if (/^-?\d+\.\d+$/.test(t)) return Number.parseFloat(t);
  const arr = t.match(INLINE_ARRAY_RE);
  if (arr) {
    const inner = arr[1];
    if (inner.trim() === '') return [];
    return inner
      .split(',')
      .map((s) => unquote(s.trim()).value)
      .filter((s) => s !== '');
  }
  return t;
}

// Parse a minimal subset of YAML sufficient for job frontmatter:
// - top-level scalar fields
// - nested objects (one level deep) for fields like `active:`
// - inline arrays `[a, b]` for `triggers:`
// - quoted strings, comments, booleans, integers
//
// Returns { frontmatter, body }. Body is everything after the closing `---`.
export function parseJobFrontmatter(content) {
  const m = content.match(FM_RE);
  if (!m) return { frontmatter: {}, body: content };

  const frontmatter = {};
  const lines = m[1].split('\n');
  let currentNested = null;
  let currentNestedKey = null;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '');
    if (line === '' || /^\s*#/.test(line)) {
      continue;
    }

    const indent = line.match(/^(\s*)/)[1].length;

    if (indent === 0) {
      // top-level key
      const kv = line.match(/^([\w-]+)\s*:\s*(.*)$/);
      if (!kv) continue;
      const key = kv[1];
      const valueRaw = kv[2];
      const value = stripInlineComment(valueRaw).trim();
      if (value === '') {
        // start of nested object
        currentNested = {};
        currentNestedKey = key;
        frontmatter[key] = currentNested;
      } else {
        frontmatter[key] = parseScalar(valueRaw);
        currentNested = null;
        currentNestedKey = null;
      }
    } else if (currentNested !== null) {
      // nested key under current parent
      const trimmed = line.trim();
      const kv = trimmed.match(/^([\w-]+)\s*:\s*(.*)$/);
      if (!kv) continue;
      currentNested[kv[1]] = parseScalar(kv[2]);
    }
  }

  return { frontmatter, body: m[2] };
}

// Validate a parsed job def. Returns { valid: true } or { valid: false, errors: [...] }.
const VALID_RUNTIMES = new Set(['agent', 'node']);
const VALID_CONTEXT_MODES = new Set(['full', 'minimal']);

export function validateJobDef(def) {
  const errors = [];
  const fm = def.frontmatter || {};

  if (!fm.name) errors.push('missing required field: name');
  if (!fm.description) errors.push('missing required field: description');
  if (!fm.runtime) errors.push('missing required field: runtime');
  if (fm.runtime && !VALID_RUNTIMES.has(fm.runtime)) {
    errors.push(`invalid runtime: ${fm.runtime} (must be 'agent' or 'node')`);
  }
  if (fm.runtime === 'node' && !fm.command) {
    errors.push('runtime: node requires command:');
  }
  // schedule is optional: trigger-only protocols don't need one. Reconciler skips
  // installing jobs without a schedule.
  if (fm.context_mode && !VALID_CONTEXT_MODES.has(fm.context_mode)) {
    errors.push(`invalid context_mode: ${fm.context_mode}`);
  }
  if (fm.active) {
    const a = fm.active;
    const hasMD = a.from_month_day || a.to_month_day;
    const hasYMD = a.from || a.to;
    if (hasMD && hasYMD) {
      errors.push('active: cannot mix from_month_day with from/to');
    }
    if (hasMD && (!a.from_month_day || !a.to_month_day)) {
      errors.push('active: from_month_day and to_month_day must both be set');
    }
    if (hasYMD && (!a.from || !a.to)) {
      errors.push('active: from and to must both be set');
    }
    if (a.from_month_day && !/^\d{2}-\d{2}$/.test(String(a.from_month_day))) {
      errors.push(`active.from_month_day: invalid format (expected MM-DD): ${a.from_month_day}`);
    }
    if (a.to_month_day && !/^\d{2}-\d{2}$/.test(String(a.to_month_day))) {
      errors.push(`active.to_month_day: invalid format (expected MM-DD): ${a.to_month_day}`);
    }
    if (a.from && !/^\d{4}-\d{2}-\d{2}$/.test(String(a.from))) {
      errors.push(`active.from: invalid format (expected YYYY-MM-DD): ${a.from}`);
    }
    if (a.to && !/^\d{4}-\d{2}-\d{2}$/.test(String(a.to))) {
      errors.push(`active.to: invalid format (expected YYYY-MM-DD): ${a.to}`);
    }
    for (const k of ['from_month_day', 'to_month_day']) {
      if (a[k] && /^\d{2}-\d{2}$/.test(String(a[k]))) {
        const [mm, dd] = a[k].split('-').map(Number);
        if (mm < 1 || mm > 12) errors.push(`active.${k}: month out of range: ${a[k]}`);
        if (dd < 1 || dd > 31) errors.push(`active.${k}: day out of range: ${a[k]}`);
        if (mm === 2 && dd > 29) errors.push(`active.${k}: impossible date: ${a[k]}`);
        if ([4, 6, 9, 11].includes(mm) && dd > 30) errors.push(`active.${k}: impossible date: ${a[k]}`);
      }
    }
  }
  if (fm.triggers && !Array.isArray(fm.triggers)) {
    errors.push('triggers: must be an array');
  }

  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}

// Apply override: merge system def + override def into an effective def.
// override wins on field collisions. If override has no body, system body is used.
export function mergeOverride(systemDef, overrideDef) {
  const fm = { ...systemDef.frontmatter };
  for (const [k, v] of Object.entries(overrideDef.frontmatter)) {
    if (k === 'override') continue;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      fm[k] = { ...(fm[k] || {}), ...v };
    } else {
      fm[k] = v;
    }
  }
  const body =
    overrideDef.body && overrideDef.body.trim().length > 0 ? overrideDef.body : systemDef.body;
  return { frontmatter: fm, body };
}
