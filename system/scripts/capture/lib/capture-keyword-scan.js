// system/scripts/capture/lib/capture-keyword-scan.js
//
// Entity-alias scanner. Used by the UserPromptSubmit hook to surface entities
// referenced in the user's message (and the prior assistant turn) so the
// recall lookup can pull related memory.

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// TODO(spec S2.2): aliases ≤2 tokens should require a `disambiguator:` keyword nearby.
// Currently every alias matches by word boundary alone — fine for multi-token names
// (Dr. Park, Marcus HYSA), prone to false positives for short single-word aliases
// (Marcus, Park).
export function scanEntityAliases(text, aliases) {
  if (!aliases?.length) return [];
  const pattern = new RegExp(`\\b(${aliases.map(escapeRegex).join('|')})\\b`, 'gi');
  const found = new Set();
  let m;
  while ((m = pattern.exec(text)) !== null) {
    const original = aliases.find((a) => a.toLowerCase() === m[1].toLowerCase());
    if (original) found.add(original);
  }
  return [...found];
}
