// links-md.js — parse v1's auto-generated LINKS.md cross-reference table.
//
// Table shape (after a markdown header row + separator):
//   | From | To | Context |
//   |------|----|---------|
//   | path/a.md | path/b.md | quoted text fragment |
//
// We skip the header/separator rows by requiring the From cell to look like a
// markdown path (`*.md` or contains a slash). Empty / malformed rows are
// dropped silently.

const ROW = /^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]*?)\s*\|/;

/**
 * @param {string} text
 * @returns {Array<{ from_path: string, to_path: string, context: string }>}
 */
export function parseLinksMd(text) {
  if (typeof text !== 'string') return [];
  const out = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const m = rawLine.match(ROW);
    if (!m) continue;
    const from = m[1].trim();
    const to = m[2].trim();
    const ctx = m[3].trim();
    if (!isPathish(from) || !isPathish(to)) continue;
    out.push({ from_path: from, to_path: to, context: ctx });
  }
  return out;
}

function isPathish(s) {
  return s.length > 0 && (s.endsWith('.md') || s.includes('/'));
}
