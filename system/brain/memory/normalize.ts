/**
 * Canonical matching key for entity names. Collapses the variant classes that
 * kept re-forking entities (financial accounts worst of all — "Maple Library Main
 * Card" / "Maple Library (Main) Card" / "Maple LIBRARY (MAIN) CARD" would be
 * separate rows): case, punctuation ("(Main)" vs "Main", "Pins&Needles" vs "PinsNeedles",
 * "⋯1234" vs "1234"), separator style ("Quick-Dry" vs "Quick Dry"), and stray
 * whitespace.
 *
 * Shared by the entity writer (alias lookup + dedup + insert), findEntity, and
 * the migration-033 backfill — the stored `entities.normalized_name` column must
 * always equal `normalizeEntityName(canonical_name)`, so keep this pure and
 * dependency-free.
 */
export function normalizeEntityName(raw: string): string {
  const key = raw
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[-_/\\]+/g, ' ') // separator punctuation splits words: "Quick-Dry" → "quick dry"
    // Other punctuation vanishes: "401(k)" → "401k", "Pins&Needles" → "pinsneedles" — EXCEPT '+',
    // which is brand-significant ("Apple TV+" vs "Apple TV", "Disney+") and must
    // not fold two real entities into one key.
    .replace(/[^\p{L}\p{N}\s+]+/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  // Symbol-only names (emoji, "⋯") would normalize to '' and all collide — fall
  // back to the plain lowercased form so they keep distinct keys.
  return key !== '' ? key : raw.trim().toLowerCase();
}
