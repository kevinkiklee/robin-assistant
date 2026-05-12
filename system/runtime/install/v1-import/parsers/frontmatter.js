// frontmatter.js — split a YAML frontmatter block off the head of a markdown file.
//
// v1 frontmatter is hand-edited so we accept a permissive shape: top-level
// `key: value` only, with values being strings, numbers, booleans, or ISO dates.
// Lists and nested objects are not used in v1's frontmatter; we don't parse them.

const FENCE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * @param {string} text
 * @returns {{ frontmatter: Record<string, unknown> | null, body: string }}
 */
export function parseFrontmatter(text) {
  if (typeof text !== 'string') return { frontmatter: null, body: '' };
  const m = text.match(FENCE);
  if (!m) return { frontmatter: null, body: text };
  const block = m[1];
  const body = text.slice(m[0].length);
  const fm = {};
  for (const line of block.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const colon = trimmed.indexOf(':');
    if (colon < 1) continue;
    const key = trimmed.slice(0, colon).trim();
    const raw = trimmed.slice(colon + 1).trim();
    fm[key] = coerce(raw);
  }
  return { frontmatter: fm, body };
}

function coerce(raw) {
  if (raw === '' || raw === '~' || raw === 'null') return null;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  // Quoted string — strip exactly one set of matching quotes.
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  // Numbers
  if (/^-?\d+$/.test(raw)) return Number.parseInt(raw, 10);
  if (/^-?\d+\.\d+$/.test(raw)) return Number.parseFloat(raw);
  // ISO date (YYYY-MM-DD or full timestamp) — return as string; caller parses.
  return raw;
}
