// list-of-entries.js — parse an undated list-shaped markdown body.
//
// Used for v1's `self-improvement/{preferences,patterns}.md` and similar.
// Two shapes both yield one entry per visible chunk:
//   1. H2/H3 sections (`## Title` or `### Title`) → one entry per section, body
//      = everything until the next header or EOF.
//   2. Top-level bullets (`- entry text`, possibly multi-line with indentation)
//      → one entry per top-level bullet.
//
// If both shapes appear in the same file, H2/H3 sections win at the top level
// and bullets-within-sections become part of the section body (not their own
// entries).

const HEAD = /^(##|###)\s+(.+?)\s*$/;
const BULLET_TOP = /^[-*+]\s+(.+)$/;

/**
 * @param {string} text
 * @returns {Array<{ title: string | null, content: string, line: number }>}
 */
export function parseListOfEntries(text) {
  if (typeof text !== 'string') return [];
  const lines = text.split(/\r?\n/);

  // Scan for H2/H3 sections first.
  const headIdx = [];
  for (let i = 0; i < lines.length; i++) {
    if (HEAD.test(lines[i])) headIdx.push(i);
  }

  if (headIdx.length > 0) {
    const out = [];
    for (let h = 0; h < headIdx.length; h++) {
      const m = lines[headIdx[h]].match(HEAD);
      if (!m) continue;
      const start = headIdx[h] + 1;
      const end = h + 1 < headIdx.length ? headIdx[h + 1] : lines.length;
      const content = lines.slice(start, end).join('\n').trim();
      if (!content) continue;
      out.push({ title: m[2].trim(), content, line: headIdx[h] + 1 });
    }
    return out;
  }

  // Otherwise: top-level bullets. Anchor on lines matching BULLET_TOP at
  // column 0; subsequent indented or paragraph-continuation lines fold into
  // the previous bullet.
  const out = [];
  let current = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(BULLET_TOP);
    if (m && !line.startsWith(' ') && !line.startsWith('\t')) {
      if (current) out.push(current);
      current = { title: null, content: m[1].trim(), line: i + 1 };
      continue;
    }
    if (current && line.trim().length > 0) {
      current.content += `\n${line.trimEnd()}`;
    } else if (current && line.trim().length === 0) {
      // Blank line: terminate the current bullet.
      out.push(current);
      current = null;
    }
  }
  if (current) out.push(current);
  return out.map((e) => ({ ...e, content: e.content.trim() })).filter((e) => e.content.length > 0);
}
