// Loads YAML trigger definitions from a directory and compiles them into
// trigger objects the engine can register.
//
// YAML schema:
//   name: low-recovery-cardio-flag      (required, unique)
//   on: whoop                            (required — event.source)
//   priority: 100                        (optional, default 100; lower fires first)
//   cooldown_ms: 86400000                (optional)
//   vars:                                (optional — keys → SurrealQL queries)
//     prev_recovery_7d_median: |
//       SELECT VALUE math::median(recovery) FROM whoop
//       WHERE date > time::now() - 7d
//   when: "event.recovery < 50 && $vars.prev_recovery_7d_median > 65"
//   do:
//     - tool: macos_notify
//       args:
//         title: "Recovery {event.recovery}%"
//         body: "Yesterday was {$vars.prev_recovery_7d_median}; skip cardio"
//     - tool: discord_send
//       args:
//         channel: dm
//         message: "Recovery {event.recovery}%"
//
// Trust model: YAML triggers live under user-data/triggers/. The `when`
// expression compiles to `new Function('event', 'vars', 'return ...')` —
// same trust level as user-data scripts. Do NOT load triggers from
// untrusted sources.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';

export function compileWhen(source) {
  if (source == null) return null;
  if (typeof source !== 'string') throw new Error('when must be a string expression');
  // `$vars.foo` is rewritten to `vars.foo` so users can use the readable $-prefix.
  const expr = source.replace(/\$vars\./g, 'vars.');
  let fn;
  try {
    fn = new Function('event', 'vars', `"use strict"; return (${expr});`);
  } catch (e) {
    throw new Error(`when expression parse failed: ${e.message}`);
  }
  return ({ event, vars = {} }) => {
    try {
      return !!fn(event, vars);
    } catch {
      return false;
    }
  };
}

// Compile a value that may contain {event.foo} or {$vars.foo} placeholders
// into a function that resolves them at fire time. Non-string values are
// returned as constant resolvers.
export function compileTemplate(value) {
  if (typeof value !== 'string') {
    return () => value;
  }
  const tokens = parseTemplate(value);
  return ({ event, vars = {} }) => {
    return tokens
      .map((t) => {
        if (t.kind === 'literal') return t.text;
        try {
          const root = t.path[0] === '$vars' ? vars : event;
          let cur = root;
          // path[0] is the root ('event' or '$vars'); always skip it.
          for (let i = 1; i < t.path.length; i += 1) {
            if (cur == null) return '';
            cur = cur[t.path[i]];
          }
          return cur == null ? '' : String(cur);
        } catch {
          return '';
        }
      })
      .join('');
  };
}

function parseTemplate(s) {
  const tokens = [];
  let i = 0;
  while (i < s.length) {
    const open = s.indexOf('{', i);
    if (open === -1) {
      tokens.push({ kind: 'literal', text: s.slice(i) });
      break;
    }
    if (open > i) tokens.push({ kind: 'literal', text: s.slice(i, open) });
    const close = s.indexOf('}', open + 1);
    if (close === -1) {
      tokens.push({ kind: 'literal', text: s.slice(open) });
      break;
    }
    const inner = s.slice(open + 1, close).trim();
    // Two shapes: `event.path.to.field` or `$vars.path.to.field`
    if (/^(\$vars|event)(\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(inner)) {
      tokens.push({ kind: 'path', path: inner.split('.') });
    } else {
      // Unrecognized — keep as literal so users notice rather than silently produce ''.
      tokens.push({ kind: 'literal', text: s.slice(open, close + 1) });
    }
    i = close + 1;
  }
  return tokens;
}

// Compile args: if object, recurse field-by-field; if string, compile template.
export function compileArgs(args) {
  if (args == null) return () => ({});
  if (typeof args !== 'object' || Array.isArray(args)) {
    const t = compileTemplate(args);
    return (ctx) => t(ctx);
  }
  const compiled = {};
  for (const [k, v] of Object.entries(args)) {
    compiled[k] = compileTemplate(v);
  }
  return (ctx) => {
    const out = {};
    for (const [k, fn] of Object.entries(compiled)) out[k] = fn(ctx);
    return out;
  };
}

// Build a vars-resolver that runs each vars-query against the DB at fire time.
// Returns an async function that returns the resolved `{ name: value }` object.
export function compileVarsResolver(varsSpec, { db }) {
  if (!varsSpec || typeof varsSpec !== 'object') return async () => ({});
  const entries = Object.entries(varsSpec);
  return async () => {
    const out = {};
    for (const [name, query] of entries) {
      if (typeof query !== 'string') continue;
      try {
        const [rows] = await db.query(query).collect();
        // Most natural: SELECT VALUE returns scalars or array of scalars; pick first.
        out[name] = Array.isArray(rows) ? rows[0] : rows;
      } catch (e) {
        out[name] = null;
      }
    }
    return out;
  };
}

// Convert a parsed YAML trigger document into the runtime trigger object
// the engine accepts. The when-predicate and action args resolve vars
// lazily per fire.
export function compileTrigger(doc, { db } = {}) {
  if (!doc?.name) throw new Error('trigger: name required');
  if (!doc.on) throw new Error(`trigger ${doc.name}: on required`);
  if (!Array.isArray(doc.do) || doc.do.length === 0) {
    throw new Error(`trigger ${doc.name}: do[] required`);
  }
  const whenFn = doc.when ? compileWhen(doc.when) : null;
  const varsResolver = compileVarsResolver(doc.vars, { db });
  const actions = doc.do.map((step) => ({
    tool: step.tool,
    retries: step.retries,
    args: async ({ event }) => {
      const vars = await varsResolver();
      const argFn = compileArgs(step.args ?? {});
      return argFn({ event, vars });
    },
  }));
  return {
    name: doc.name,
    on: doc.on,
    priority: doc.priority,
    cooldownMs: doc.cooldown_ms,
    when: whenFn
      ? async ({ event }) => {
          const vars = await varsResolver();
          return whenFn({ event, vars });
        }
      : undefined,
    do: actions,
  };
}

// Walk a directory of YAML trigger files and return compiled trigger objects.
// Returns { triggers, errors[] } so partial failure doesn't block loading.
export function loadTriggersFromDir(dir, { db } = {}) {
  if (!dir || !existsSync(dir)) return { triggers: [], errors: [] };
  const triggers = [];
  const errors = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.yaml') && !entry.name.endsWith('.yml')) continue;
    const path = join(dir, entry.name);
    try {
      const text = readFileSync(path, 'utf8');
      const doc = yaml.load(text);
      triggers.push(compileTrigger(doc, { db }));
    } catch (e) {
      errors.push({ path, error: e.message });
    }
  }
  return { triggers, errors };
}
