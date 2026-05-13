import { customAlphabet } from 'nanoid';
import { basename, extname } from 'node:path';
import {
  SLUG_ALPHABET,
  SLUG_SUFFIX_LENGTH,
  SLUG_MAX_LENGTH,
  RESERVED_SLUG_PREFIX,
} from './config.js';

const nano = customAlphabet(SLUG_ALPHABET, SLUG_SUFFIX_LENGTH);

export function sanitizeSlug(input) {
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

function firstH1(body) {
  if (!body) return '';
  const m = body.match(/^#\s+(.+?)\s*$/m);
  return m ? m[1] : '';
}

function firstLine(body) {
  if (!body) return '';
  for (const line of body.split('\n')) {
    const t = line.trim();
    if (t) return t.slice(0, 60);
  }
  return '';
}

export function deriveSlug({ explicit, source, isDirectory, body, frontmatter }) {
  const candidates = [];
  if (explicit) candidates.push({ raw: explicit, origin: 'user-specified' });
  if (source && isDirectory) candidates.push({ raw: basename(source), origin: 'robin-derived' });
  else if (source) candidates.push({ raw: basename(source, extname(source)), origin: 'robin-derived' });
  candidates.push({ raw: firstH1(body), origin: 'robin-derived' });
  candidates.push({ raw: firstLine(body), origin: 'robin-derived' });
  candidates.push({ raw: 'page', origin: 'robin-derived' });

  for (const c of candidates) {
    const slug = sanitizeSlug(c.raw);
    if (slug) return { slug, origin: c.origin };
  }
  return { slug: 'page', origin: 'robin-derived' };
}

export function appendSuffix(base) {
  const suffix = '-' + nano();
  const room = SLUG_MAX_LENGTH - suffix.length;
  const trimmedBase = base.slice(0, room).replace(/-+$/, '');
  return trimmedBase + suffix;
}
