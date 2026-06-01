import { basename, extname } from 'node:path';
import { customAlphabet } from 'nanoid';
import {
  REFUSED_SLUG_PATTERN,
  RESERVED_SLUG_PREFIX,
  SLUG_ALPHABET,
  SLUG_MAX_LENGTH,
  SLUG_SUFFIX_LENGTH,
} from './config.ts';

const nano = customAlphabet(SLUG_ALPHABET, SLUG_SUFFIX_LENGTH);

/**
 * True when `slug` names content the pipeline must never publish to the web
 * (currently: the private daily brief). Enforced in `publish()` for every
 * mode except `delete`. See `REFUSED_SLUG_PATTERN`.
 */
export function isRefusedSlug(slug: string): boolean {
  return REFUSED_SLUG_PATTERN.test(slug);
}

export function sanitizeSlug(input: string | null | undefined): string {
  if (!input) return '';
  const raw = String(input);
  if (raw.startsWith(RESERVED_SLUG_PREFIX)) return '';
  let s = raw.toLowerCase();
  s = s.replace(/[^a-z0-9-]+/g, '-');
  s = s.replace(/-+/g, '-');
  s = s.replace(/^-+|-+$/g, '');
  if (s.length > SLUG_MAX_LENGTH) s = s.slice(0, SLUG_MAX_LENGTH).replace(/-+$/, '');
  return s;
}

function firstH1(body: string): string {
  if (!body) return '';
  const m = body.match(/^#\s+(.+?)\s*$/m);
  return m ? m[1] : '';
}

function firstLine(body: string): string {
  if (!body) return '';
  for (const line of body.split('\n')) {
    const t = line.trim();
    if (t) return t.slice(0, 60);
  }
  return '';
}

export interface DeriveSlugInput {
  explicit?: string | null;
  source: string | null;
  isDirectory?: boolean;
  body: string;
  frontmatter?: Record<string, unknown>;
}

export interface DeriveSlugResult {
  slug: string;
  origin: 'user-specified' | 'robin-derived';
}

export function deriveSlug(input: DeriveSlugInput): DeriveSlugResult {
  const candidates: Array<{ raw: string; origin: 'user-specified' | 'robin-derived' }> = [];
  if (input.explicit) candidates.push({ raw: input.explicit, origin: 'user-specified' });
  const fmSlug = input.frontmatter?.slug;
  if (typeof fmSlug === 'string') candidates.push({ raw: fmSlug, origin: 'user-specified' });
  const fmTitle = input.frontmatter?.title;
  if (typeof fmTitle === 'string') candidates.push({ raw: fmTitle, origin: 'robin-derived' });
  if (input.source && input.isDirectory) {
    candidates.push({ raw: basename(input.source), origin: 'robin-derived' });
  } else if (input.source) {
    candidates.push({
      raw: basename(input.source, extname(input.source)),
      origin: 'robin-derived',
    });
  }
  candidates.push({ raw: firstH1(input.body), origin: 'robin-derived' });
  candidates.push({ raw: firstLine(input.body), origin: 'robin-derived' });
  candidates.push({ raw: 'page', origin: 'robin-derived' });

  for (const c of candidates) {
    const slug = sanitizeSlug(c.raw);
    if (slug) return { slug, origin: c.origin };
  }
  return { slug: 'page', origin: 'robin-derived' };
}

export function appendSuffix(base: string): string {
  const suffix = `-${nano()}`;
  const room = SLUG_MAX_LENGTH - suffix.length;
  const trimmedBase = base.slice(0, room).replace(/-+$/, '');
  return trimmedBase + suffix;
}
