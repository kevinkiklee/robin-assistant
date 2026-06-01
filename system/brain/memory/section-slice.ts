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
}

/** Below this size the whole doc is already a reasonable snippet — don't bother slicing. */
const DEFAULT_MIN_BODY = 1500;

/** Query tokens this short (or in the stoplist) carry no topical signal. */
const MIN_TOKEN_LEN = 3;
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'are', 'was', 'has', 'have',
  'what', 'when', 'where', 'which', 'who', 'how', 'why', 'about', 'into',
  'from', 'your', 'you', 'can', 'should', 'would', 'does', 'did', 'not',
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

/** Count distinct query tokens present (as substrings) in `text`. */
function tokenHits(text: string, tokens: string[]): number {
  const hay = text.toLowerCase();
  let n = 0;
  for (const t of tokens) if (hay.includes(t)) n++;
  return n;
}

/**
 * Return the H2 section of `body` most relevant to `query`, breadcrumb-prefixed
 * (`Doc Title › Section Heading: …`). Returns `body` unchanged when it's small, has no H2
 * structure, or no section beats a zero query-token score (the safe semantic-only fallback).
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
  // than the same token buried in prose. First section wins ties (stable, favors order).
  let best = -1;
  let bestScore = 0;
  sections.forEach((s, i) => {
    const score = tokenHits(s.body, tokens) + 2 * tokenHits(s.heading, tokens);
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  });
  if (best < 0) return body; // no lexical overlap anywhere — fall back to top-truncation

  const chosen = sections[best];
  // Doc title = the H1, if any. Strip it out of a chosen preamble body to avoid echoing it
  // in both the breadcrumb and the text.
  const h1 = body.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? '';
  const crumbs = [h1, chosen.heading].filter(Boolean).join(' › ');
  const text = chosen.heading
    ? chosen.body
    : chosen.body.replace(/^#\s+.+$/m, '').trim(); // preamble: drop the H1 line
  return crumbs ? `${crumbs}: ${text}` : text;
}
