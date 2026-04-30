// watches.js — lib helpers for watch-id, paths, state I/O
// Used by the watch-topics agent-runtime job and the `robin watch` CLI.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

// ---------------------------------------------------------------------------
// Slug / id helpers
// ---------------------------------------------------------------------------

/**
 * Convert a free-text topic string to a kebab-case watch id.
 * Max 60 chars, lowercase, alphanumeric + hyphens.
 *
 * Examples:
 *   "Aronofsky's mother! Blu-ray release" → "aronofsky-mother-blu-ray-release"
 *   "new Sigma lens releases"             → "new-sigma-lens-releases"
 */
export function slugify(topic) {
  return topic
    .toLowerCase()
    .replace(/[\x27\u2018\u2019\u201A\u201B`]/g, '')  // strip apostrophes/smart-quotes (avoid s-artifact)
    .replace(/[^a-z0-9\s-]/g, ' ') // strip remaining non-alphanumeric (keep spaces + hyphens)
    .trim()
    .replace(/[\s-]+/g, '-')        // collapse whitespace/hyphens to single hyphen
    .replace(/^-+|-+$/g, '')        // trim leading/trailing hyphens
    .slice(0, 60)
    .replace(/-+$/, '');            // trim trailing hyphens after slice
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** Full path to a watch markdown file. */
export function watchPath(workspaceDir, id) {
  return join(workspaceDir, 'user-data/memory/watches', `${id}.md`);
}

/** Full path to a watch state JSON file. */
export function watchStatePath(workspaceDir, id) {
  return join(workspaceDir, 'user-data/state/watches', `${id}.json`);
}

// ---------------------------------------------------------------------------
// Frontmatter parse / serialize
// ---------------------------------------------------------------------------

/**
 * Parse a watch markdown file into { frontmatter, body }.
 * Frontmatter is returned as a plain object (string values).
 * Body is the text after the closing `---`.
 */
export function parseWatchFile(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: content };
  }
  const rawYaml = match[1];
  const body = match[2] ?? '';

  const frontmatter = {};
  for (const line of rawYaml.split('\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    // Attempt to coerce common scalar types
    if (value === 'null') frontmatter[key] = null;
    else if (value === 'true') frontmatter[key] = true;
    else if (value === 'false') frontmatter[key] = false;
    else if (/^\d+$/.test(value)) frontmatter[key] = Number(value);
    else if (value.startsWith('"') && value.endsWith('"')) frontmatter[key] = value.slice(1, -1);
    else if (value.startsWith("'") && value.endsWith("'")) frontmatter[key] = value.slice(1, -1);
    else if (value.startsWith('[') && value.endsWith(']')) {
      // simple empty-array support
      frontmatter[key] = value === '[]' ? [] : value;
    } else {
      frontmatter[key] = value;
    }
  }
  return { frontmatter, body };
}

/**
 * Serialize frontmatter object + body back to a markdown string.
 */
export function serializeWatchFile(frontmatter, body) {
  const lines = ['---'];
  for (const [key, value] of Object.entries(frontmatter)) {
    if (value === null) {
      lines.push(`${key}: null`);
    } else if (typeof value === 'boolean') {
      lines.push(`${key}: ${value}`);
    } else if (Array.isArray(value) && value.length === 0) {
      lines.push(`${key}: []`);
    } else if (typeof value === 'string' && value.includes(':')) {
      // Quote strings that contain colons to avoid YAML ambiguity
      lines.push(`${key}: "${value}"`);
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  lines.push('---');
  lines.push('');
  return lines.join('\n') + (body.startsWith('\n') ? body : body ? '\n' + body : '');
}

// ---------------------------------------------------------------------------
// Watch list
// ---------------------------------------------------------------------------

/**
 * Read all watch markdown files in the watches directory.
 * Returns an array of { id, topic, cadence, enabled, last_run_at, query, notify, created_at }.
 * Returns [] if the directory doesn't exist.
 */
export function listWatches(workspaceDir) {
  const watchesDir = join(workspaceDir, 'user-data/memory/watches');
  if (!existsSync(watchesDir)) return [];

  const files = readdirSync(watchesDir).filter(
    (f) => f.endsWith('.md') && f !== 'INDEX.md' && f !== 'log.md',
  );

  const watches = [];
  for (const file of files) {
    const id = file.replace(/\.md$/, '');
    const content = readFileSync(join(watchesDir, file), 'utf8');
    const { frontmatter } = parseWatchFile(content);
    watches.push({
      id,
      topic: frontmatter.topic ?? id,
      cadence: frontmatter.cadence ?? 'daily',
      enabled: frontmatter.enabled !== false,
      last_run_at: frontmatter.last_run_at ?? null,
      query: frontmatter.query ?? frontmatter.topic ?? id,
      notify: frontmatter.notify === true,
      created_at: frontmatter.created_at ?? null,
    });
  }

  return watches;
}

// ---------------------------------------------------------------------------
// State I/O
// ---------------------------------------------------------------------------

const DEFAULT_STATE = {
  fingerprints: [],
  last_run_at: null,
  consecutive_failures: 0,
};

/**
 * Read per-watch state JSON, or return a default state object.
 */
export function readWatchState(workspaceDir, id) {
  const path = watchStatePath(workspaceDir, id);
  if (!existsSync(path)) {
    return { ...DEFAULT_STATE, id };
  }
  try {
    const raw = readFileSync(path, 'utf8');
    return { ...DEFAULT_STATE, id, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_STATE, id };
  }
}

/**
 * Atomically write per-watch state JSON.
 * Uses <path>.tmp + renameSync for crash safety.
 */
export function writeWatchState(workspaceDir, id, state) {
  const path = watchStatePath(workspaceDir, id);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...state, id }, null, 2) + '\n', 'utf8');
  renameSync(tmp, path);
}
