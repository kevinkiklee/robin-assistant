/**
 * Recommendation→Action Loop — text-mention matching (audit 2026-10-02).
 *
 * `subjectMatches` (store.ts) asks "is the signal's object a named entity inside the rec's
 * subject?" — right for a calendar title or a biographer decision, useless for commerce:
 * a transaction merchant is "Amazon"/"B&H", never "Acme Bread Box". The
 * reverse question is the one an order email answers: "does this text mention the rec's
 * product?" — so match on the rec subject's DISTINCTIVE tokens appearing in the text.
 *
 * Precision rules (deterministic, no LLM — fuzzy cases are the scan's LLM pass):
 *  - tokens are lowercase alnum word-runs (same normalization as subjectMatches);
 *  - stopwords, single characters, and bare numbers are never distinctive;
 *  - GENERIC category words ("lens", "camera", "filter") are dropped from the required
 *    set — "Camera" alone is what Amazon's subject line says about every camera item;
 *  - a match needs EVERY remaining required token present as a whole word in the text,
 *    and either ≥2 of them or one alnum model token ("at80", "x200", "f100").
 */

const STOPWORDS: ReadonlySet<string> = new Set([
  'a',
  'an',
  'and',
  'as',
  'at',
  'by',
  'for',
  'from',
  'in',
  'into',
  'is',
  'it',
  'its',
  'my',
  'of',
  'on',
  'or',
  'the',
  'to',
  'up',
  'vs',
  'via',
  'with',
  'without',
  'your',
  'new',
  'use',
  'using',
  'get',
  'buy',
  'try',
  'skip',
  'avoid',
  'wait',
  'more',
  'this',
  'that',
]);

/** Category nouns too common in order/shipping text to anchor a product match alone. */
const GENERIC: ReadonlySet<string> = new Set([
  'camera',
  'cameras',
  'lens',
  'lenses',
  'filter',
  'filters',
  'kit',
  'set',
  'pack',
  'bag',
  'case',
  'strap',
  'cap',
  'item',
  'items',
  'order',
  'book',
  'books',
  'gear',
  'mount',
  'adapter',
  'battery',
  'batteries',
  'charger',
  'cable',
  'card',
  'mm',
  'inch',
  'pro',
  'plus',
  'mini',
  'max',
  'edition',
  'version',
  'black',
  'white',
  'photography',
  'photo',
  'trip',
  'visit',
  'hike',
  'day',
  'weekend',
]);

/** Lowercase alnum word-runs (identical normalization to store.ts normalizeText). */
export function tokenize(text: string): string[] {
  const norm = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return norm ? norm.split(' ') : [];
}

function isModelToken(t: string): boolean {
  return t.length >= 3 && /[a-z]/.test(t) && /[0-9]/.test(t);
}

/**
 * The subject's distinctive tokens — the ones a mention must contain. Stopwords, single
 * characters, bare numbers, and GENERIC category words are excluded. Deduplicated,
 * order-preserving.
 */
export function distinctiveTokens(subject: string): string[] {
  const out: string[] = [];
  for (const t of tokenize(subject)) {
    if (t.length < 2) continue;
    if (/^[0-9]+$/.test(t)) continue;
    if (STOPWORDS.has(t) || GENERIC.has(t)) continue;
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

/**
 * Strict mention: does `text` name the rec `subject`? Every distinctive token must appear
 * as a whole word, and the anchor must be specific enough (≥2 tokens, or one model token).
 * Used by the deterministic linker against order/shipping emails and calendar titles.
 */
export function subjectMentionedIn(subject: string, text: string): boolean {
  const required = distinctiveTokens(subject);
  if (required.length === 0) return false;
  if (required.length === 1 && !isModelToken(required[0])) return false;
  const words = new Set(tokenize(text));
  return required.every((t) => words.has(t));
}

/**
 * Loose mention — a CANDIDATE filter for the LLM pass, never a resolution rule: at least
 * two distinctive tokens present (or the only one, when the subject has a single one).
 */
export function subjectLooselyMentionedIn(subject: string, text: string): boolean {
  return looseTokenHit(distinctiveTokens(subject), new Set(tokenize(text)));
}

/** `subjectLooselyMentionedIn` over pre-computed tokens (hot loops tokenize once). */
export function looseTokenHit(required: string[], words: ReadonlySet<string>): boolean {
  if (required.length === 0) return false;
  let hits = 0;
  for (const t of required) if (words.has(t)) hits += 1;
  return required.length === 1 ? hits === 1 : hits >= 2;
}

/** Index of the first whole-word occurrence of any distinctive token (or -1). */
export function firstMentionIndex(subject: string, text: string): number {
  const lower = text.toLowerCase();
  let best = -1;
  for (const t of distinctiveTokens(subject)) {
    const m = new RegExp(`(^|[^a-z0-9])${t}([^a-z0-9]|$)`).exec(lower);
    if (m && (best === -1 || m.index < best)) best = m.index;
  }
  return best;
}
