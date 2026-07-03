/**
 * Read-time section slicing for oversized markdown-doc recall hits.
 *
 * A whole knowledge doc can be tens of KB. Injecting its first N chars as a Layer-2
 * "snippet" returns the title + intro — the LEAST query-specific part of any structured
 * doc. When a hit body is large and has `##` structure, slice to the single H2 section
 * whose heading/body best overlaps the query terms and prefix it with a breadcrumb so the
 * fragment is self-locating. Dependency-free and cheap: no AST, no re-embedding — splits
 * on `## ` lines (ignoring fenced code) and scores sections by query-token overlap.
 *
 * This is the deliberately-small alternative to ingest-time chunking: it improves snippet
 * relevance for any multi-section doc without touching the corpus, the embeddings, or the
 * provenance graph. Its ceiling is lower (the doc is still *found* by its whole-doc vector,
 * not a per-section one), so a purely-semantic match with zero lexical overlap falls back
 * to returning the body unchanged — the caller then truncates from the top as before.
 */

export interface SliceOptions {
  /** Bodies shorter than this pass through untouched (already snippet-sized). */
  minBodyChars?: number;
  /**
   * Max number of H2 sections to return (default 1). When >1, the top-scoring sections are
   * selected by relevance, then re-ordered by document position and joined with a blank line.
   */
  maxSections?: number;
  /**
   * Soft char budget across the packed sections. Sections are added greedily in document
   * order; one is skipped if it would overflow. The single top-scoring section is ALWAYS
   * kept even if it alone exceeds the budget (the caller hard-caps as a final backstop).
   */
  maxChars?: number;
}

/** Below this size the whole doc is already a reasonable snippet — don't bother slicing. */
const DEFAULT_MIN_BODY = 1500;

/** Query tokens this short (or in the stoplist) carry no topical signal. */
const MIN_TOKEN_LEN = 3;
const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'are',
  'was',
  'has',
  'have',
  'what',
  'when',
  'where',
  'which',
  'who',
  'how',
  'why',
  'about',
  'into',
  'from',
  'your',
  'you',
  'can',
  'should',
  'would',
  'does',
  'did',
  'not',
]);

interface Section {
  heading: string;
  body: string;
}

/** Lowercase topical tokens from the query (deduped, stopworded, length-gated). */
function queryTokens(query: string): string[] {
  const seen = new Set<string>();
  for (const raw of query.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < MIN_TOKEN_LEN || STOPWORDS.has(raw)) continue;
    seen.add(raw);
  }
  return [...seen];
}

/**
 * Split markdown into the preamble (everything before the first H2) plus one section per
 * H2. `##` lines inside fenced code blocks are not treated as headings. Empty sections are
 * dropped. A doc with no H2 yields a single section.
 */
function splitSections(md: string): Section[] {
  const sections: Section[] = [];
  let heading = '';
  let buf: string[] = [];
  let started = false; // have we passed the first real H2 yet?
  let inFence = false;

  const flush = () => {
    const body = buf.join('\n').trim();
    if (body.length > 0 || heading.length > 0) sections.push({ heading, body });
    buf = [];
  };

  for (const line of md.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (!inFence && /^##\s+/.test(line)) {
      flush(); // close the preamble (first time) or the previous section
      heading = line.replace(/^##\s+/, '').trim();
      started = true;
      continue;
    }
    buf.push(line);
  }
  flush();
  // `started` stays false for a doc with no H2 at all — that's fine, flush() already
  // produced the single whole-body section.
  void started;
  return sections;
}

/**
 * True when `md` has the `##` section structure the slicer needs to return a section
 * (rather than top-truncating the whole doc). Reuses `splitSections`, so it is fence-aware:
 * a `##` that appears only inside a fenced code block is not a section boundary. Used by the
 * recall-topics doctor invariant to decide whether an oversized mapped doc is sliceable.
 */
export function hasSliceableSections(md: string): boolean {
  return splitSections(md).length > 1;
}

/** Count distinct query tokens present (as substrings) in `text`. */
function tokenHits(text: string, tokens: string[]): number {
  const hay = text.toLowerCase();
  let n = 0;
  for (const t of tokens) if (hay.includes(t)) n++;
  return n;
}

/** Breadcrumb-prefix one section (`Doc Title › Heading: body`); drop the H1 from a preamble. */
function renderSection(sec: Section, h1: string): string {
  const crumbs = [h1, sec.heading].filter(Boolean).join(' › ');
  // The preamble carries the H1 line in its body — strip it so the title isn't echoed twice.
  const text = sec.heading ? sec.body : sec.body.replace(/^#\s+.+$/m, '').trim();
  return crumbs ? `${crumbs}: ${text}` : text;
}

/**
 * Return the H2 section(s) of `body` most relevant to `query`, each breadcrumb-prefixed
 * (`Doc Title › Section Heading: …`). With the default `maxSections: 1` this is the single
 * best section. With `maxSections > 1` it selects the top-scoring sections, restores document
 * order, and packs them within `maxChars` (the top section is always kept). Returns `body`
 * unchanged when it's small, has no H2 structure, or no section beats a zero query-token
 * score (the safe semantic-only fallback).
 */
export function sliceToRelevantSection(
  body: string,
  query: string,
  opts: SliceOptions = {},
): string {
  const minBody = opts.minBodyChars ?? DEFAULT_MIN_BODY;
  if (body.length < minBody) return body;

  const sections = splitSections(body);
  if (sections.length <= 1) return body; // nothing to choose between

  const tokens = queryTokens(query);
  if (tokens.length === 0) return body;

  // Heading matches weigh double — a query token in the H2 is a stronger topical signal
  // than the same token buried in prose. Keep the index for a stable document-order tiebreak.
  const scored = sections.map((s, i) => ({
    i,
    section: s,
    score: tokenHits(s.body, tokens) + 2 * tokenHits(s.heading, tokens),
  }));

  const ranked = scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score || a.i - b.i);
  if (ranked.length === 0) return body; // no lexical overlap anywhere — fall back to top-truncation

  const maxSections = Math.max(1, opts.maxSections ?? 1);
  const topIndex = ranked[0].i; // the single best section, never dropped by the budget
  // Take the top-N by relevance, then present them in document order for readability.
  const chosen = ranked.slice(0, maxSections).sort((a, b) => a.i - b.i);

  // Doc title = the H1, if any. Strip it out of a chosen preamble body to avoid echoing it.
  const h1 = body.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? '';

  const pieces: string[] = [];
  let used = 0;
  for (const c of chosen) {
    const rendered = renderSection(c.section, h1);
    const addition = pieces.length === 0 ? rendered.length : rendered.length + 2; // +2 for the join
    if (opts.maxChars !== undefined && c.i !== topIndex && used + addition > opts.maxChars)
      continue;
    pieces.push(rendered);
    used += addition;
  }
  return pieces.join('\n\n');
}
