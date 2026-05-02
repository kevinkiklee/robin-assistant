// Hard Rules integrity helpers.
//
// extractSection(md, headerName) — pulls the body of a `## <headerName>`
//   section. Requires line-start anchor + exactly two `#`. Returns null
//   if the section is missing.
// normalizeForHash(text) — strips trailing whitespace, collapses runs of
//   blank lines, trims, lowercases. Stable against cosmetic edits.
// hashHardRules(mdContent) — returns FNV-1a-64 hex of the normalized
//   "## Hard Rules" section, or null if missing.

import { fnv1a64 } from '../sync/lib/untrusted-index.js';

export function extractSection(md, headerName) {
  if (typeof md !== 'string') return null;
  const escaped = headerName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // ^## [whitespace] <headerName> [optional trailing chars] \n then capture
  // until the next `^## ` header or end of input. JS has no \Z so we use
  // negative-lookahead-on-any-char to mean "end of input."
  const re = new RegExp(`^##\\s+${escaped}\\b[^\\n]*\\n([\\s\\S]*?)(?=\\n##\\s+|$(?![\\s\\S]))`, 'm');
  const m = md.match(re);
  return m ? m[1].trim() : null;
}

export function normalizeForHash(text) {
  if (typeof text !== 'string') return '';
  return text
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function hashHardRules(mdContent) {
  const section = extractSection(mdContent, 'Hard Rules');
  if (section === null) return null;
  return fnv1a64(normalizeForHash(section));
}
