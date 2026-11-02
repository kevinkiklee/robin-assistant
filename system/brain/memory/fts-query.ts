/**
 * Build a safe FTS5 MATCH expression from free text.
 *
 * The old recall sanitizer only stripped `- : * " ^`, so any prompt containing
 * `.`, `?`, `'`, `,`, `/`, `[`, `<` … raised an FTS5 syntax error and the lexical
 * branch silently returned nothing. Measured 2026-10-03 on 60 real prompts: 43
 * (72%) failed to parse. Even the ones that parsed were bare-word implicit-AND
 * queries, so a long conversational prompt matched almost nothing while a short
 * one ("ok sounds good, do that") matched on stopwords alone.
 *
 * This extracts word tokens (Unicode letters/digits — the same split the default
 * `unicode61` tokenizer makes), drops stopwords and contraction fragments, dedupes,
 * caps the term count, and double-quotes every term so nothing can be read as an
 * operator. `all` joins with implicit AND (manual recall's historical semantics);
 * `any` joins with OR so bm25 ranks by how many rare terms a row shares with a
 * conversational prompt — the caller then needs a score floor (see recall.ts).
 * Returns '' when no content term survives — the caller must skip the lex branch.
 */

/** Cap on terms — bounds FTS cost on a pasted file and keeps bm25 focused on the prompt head. */
export const MAX_FTS_TERMS = 24;

const STOPWORDS: ReadonlySet<string> = new Set(
  `a about above after again against all also am an and any are aren as at be because been before
  being below between both but by can cannot could couldn did didn do does doesn doing don down
  during each few for from further get got had hasn has have haven having he her here hers herself
  him himself his how i if in into is isn it its itself just let me more most my myself no nor not
  now of off on once only or other ought our ours ourselves out over own same she should shouldn
  so some such than that the their theirs them themselves then there these they this those through
  to too under until up very was wasn we were weren what when where which while who whom why will
  with won would wouldn you your yours yourself yourselves ok okay yes yeah please thanks thank
  want wants need needs make made take care go goes going gone ahead look looks looking see seen
  think know like really maybe sure still even well way thing things something anything everything
  one two use using used tell said say says sound sounds right good great new next now also lets
  us vs ve ll re hi oh ah im eh id ya`
    .split(/\s+/)
    .filter(Boolean),
);

/** Word tokens of `text` that carry topical signal. Exported for tests. */
export function contentTerms(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of text.toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)) {
    const tok = m[0];
    // Single characters (contraction tails "t"/"s"/"m") carry no topic; two-letter
    // tokens survive unless listed ("x1", "x2", "q3" are model names; "is", "ve" are not).
    if (tok.length < 2) continue;
    if (STOPWORDS.has(tok)) continue;
    if (seen.has(tok)) continue;
    seen.add(tok);
    out.push(tok);
    if (out.length >= MAX_FTS_TERMS) break;
  }
  return out;
}

export function buildFtsQuery(text: string, match: 'all' | 'any' = 'all'): string {
  const terms = contentTerms(text);
  if (terms.length === 0) return '';
  // Tokens are [\p{L}\p{N}]+ only, so they can't contain a double quote; quoting
  // makes reserved words (AND/OR/NOT/NEAR) plain terms.
  return terms.map((t) => `"${t}"`).join(match === 'any' ? ' OR ' : ' ');
}
