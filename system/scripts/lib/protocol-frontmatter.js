// Parser for protocol-specific frontmatter fields used by the subagent
// dispatch system. Reads dispatch + model from system/jobs/<name>.md.
//
// Frontmatter shape:
//   ---
//   name: <name>
//   dispatch: subagent | inline
//   model: opus | sonnet | haiku
//   triggers: ["..."]
//   description: ...
//   ...
//   ---
//
// CLAUDE.md amendment instructs the parent agent to read these fields when
// the user invokes a protocol. If dispatch=subagent (and the feature flag
// in user-data/runtime/config/robin.config.json's `optimize.subagent_dispatch`
// allows it), the parent dispatches the protocol to a subagent with the
// declared model. Otherwise it runs inline.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const JOBS_DIR = join(REPO_ROOT, 'system', 'jobs');

const FM_RE = /^---\n([\s\S]*?)\n---\n?/;

const VALID_DISPATCH = new Set(['subagent', 'inline']);
const VALID_MODELS = new Set(['opus', 'sonnet', 'haiku']);

export function parseProtocolFrontmatter(content) {
  const m = content.match(FM_RE);
  if (!m) return { frontmatter: {}, body: content };
  const frontmatter = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (!kv) continue;
    const [, key, raw] = kv;
    frontmatter[key] = parseValue(raw);
  }
  return { frontmatter, body: content.slice(m[0].length) };
}

function parseValue(raw) {
  const trimmed = raw.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (/^-?\d+$/.test(trimmed)) return Number(trimmed);
  if (/^"(.*)"$/.test(trimmed)) return trimmed.slice(1, -1);
  if (/^'(.*)'$/.test(trimmed)) return trimmed.slice(1, -1);
  // Array notation: ["a", "b"] or [a, b]
  const arr = trimmed.match(/^\[(.*)\]$/);
  if (arr) {
    return arr[1].split(',').map((s) => {
      const t = s.trim();
      const sm = t.match(/^["'](.*)["']$/);
      return sm ? sm[1] : t;
    }).filter((s) => s.length > 0);
  }
  return trimmed;
}

export function readProtocolFile(name) {
  const path = join(JOBS_DIR, `${name}.md`);
  if (!existsSync(path)) throw new Error(`Protocol not found: ${name}`);
  return parseProtocolFrontmatter(readFileSync(path, 'utf8'));
}

export function listProtocols(jobsDir = JOBS_DIR) {
  return readdirSync(jobsDir)
    .filter((f) => f.endsWith('.md') && !f.startsWith('_') && f !== 'README.md')
    .map((f) => f.replace(/\.md$/, ''))
    .sort();
}

export function listProtocolsWithFrontmatter(jobsDir = JOBS_DIR) {
  return listProtocols(jobsDir).map((name) => {
    const path = join(jobsDir, `${name}.md`);
    const text = readFileSync(path, 'utf8');
    const { frontmatter } = parseProtocolFrontmatter(text);
    return { name, frontmatter };
  });
}

// Validate dispatch + model fields. Returns array of issues; empty = valid.
export function validateProtocolFrontmatter(name, frontmatter) {
  const issues = [];
  const dispatch = frontmatter.dispatch;
  const model = frontmatter.model;
  if (dispatch === undefined) {
    issues.push(`${name}: missing 'dispatch' frontmatter field (expected: subagent | inline)`);
  } else if (!VALID_DISPATCH.has(dispatch)) {
    issues.push(`${name}: invalid dispatch '${dispatch}' (expected: subagent | inline)`);
  }
  if (model === undefined) {
    issues.push(`${name}: missing 'model' frontmatter field (expected: opus | sonnet | haiku)`);
  } else if (!VALID_MODELS.has(model)) {
    issues.push(`${name}: invalid model '${model}' (expected: opus | sonnet | haiku)`);
  }
  return issues;
}

export function validateAllProtocols(jobsDir = JOBS_DIR) {
  const issues = [];
  for (const { name, frontmatter } of listProtocolsWithFrontmatter(jobsDir)) {
    issues.push(...validateProtocolFrontmatter(name, frontmatter));
  }
  return issues;
}

export const VALID_DISPATCH_VALUES = [...VALID_DISPATCH];
export const VALID_MODEL_VALUES = [...VALID_MODELS];
