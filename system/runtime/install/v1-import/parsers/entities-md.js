// entities-md.js — parse v1's auto-generated ENTITIES.md alias index.
//
// Line shape (one per entity):
//   - <Canonical Name> (<alias 1>, <alias 2>, ...) — <path/to/source.md>
//
// The em dash separator is a literal U+2014. The aliases parenthetical may
// also include the canonical name itself (Dream's emitter is sloppy) — we
// dedupe later. Lines that don't match the pattern are skipped silently
// (header, comments, blank).

const LINE = /^-\s+(.+?)\s+\(([^)]*)\)\s+—\s+(.+)$/;

/**
 * @param {string} text
 * @returns {Array<{ canonical_name: string, aliases: string[], source_path: string }>}
 */
export function parseEntitiesMd(text) {
  if (typeof text !== 'string') return [];
  const out = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const m = rawLine.match(LINE);
    if (!m) continue;
    const canonical_name = m[1].trim();
    const aliasField = m[2];
    const source_path = m[3].trim();
    const aliases = aliasField
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && s !== canonical_name);
    // De-dupe aliases while preserving order.
    const seen = new Set();
    const uniqueAliases = [];
    for (const a of aliases) {
      if (seen.has(a)) continue;
      seen.add(a);
      uniqueAliases.push(a);
    }
    out.push({ canonical_name, aliases: uniqueAliases, source_path });
  }
  return out;
}
