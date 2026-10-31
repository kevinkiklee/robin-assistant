import matter from 'gray-matter';
import { defaultSchema } from 'rehype-sanitize';

export interface FrontmatterExtracted {
  frontmatter: Record<string, unknown>;
  body: string;
}

export function extractFrontmatter(src: string): FrontmatterExtracted {
  const parsed = matter(src);
  return { frontmatter: (parsed.data ?? {}) as Record<string, unknown>, body: parsed.content };
}

export function normalizeMarkdown(src: string): string {
  let s = src;
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  s = s.replace(/\r\n/g, '\n');
  return s;
}

// `clobberPrefix: ''` + removing `id` from clobber keeps heading IDs as-is
// (`id="my-section"` rather than `id="user-content-my-section"`) so internal
// anchor links work without a prefix. Safe here because published pages are
// top-level documents, not embedded fragments.
const baseAllAttrs = defaultSchema.attributes?.['*'] ?? [];
const baseAAttrs = defaultSchema.attributes?.a ?? [];
const baseImgAttrs = defaultSchema.attributes?.img ?? [];
const baseClobber = defaultSchema.clobber ?? [];

// Loose schema shape — `rehype-sanitize` accepts a wide structural type; we
// annotate as `unknown` here to avoid leaking deep dep paths into our .d.ts.
export const sanitizeSchema: Record<string, unknown> = {
  ...defaultSchema,
  clobberPrefix: '',
  clobber: baseClobber.filter((a) => a !== 'id'),
  protocols: {
    ...defaultSchema.protocols,
    src: ['http', 'https', 'data'],
    href: ['http', 'https', 'mailto', 'tel'],
  },
  attributes: {
    ...defaultSchema.attributes,
    '*': [...baseAllAttrs.filter((a) => !String(a).startsWith('on')), 'id', 'className'],
    a: [...baseAAttrs, 'rel', 'target'],
    img: [...baseImgAttrs, 'alt', 'src', 'title', 'width', 'height', 'loading'],
  },
  tagNames: (defaultSchema.tagNames ?? []).filter(
    (t) => !['script', 'iframe', 'object', 'embed', 'form', 'base'].includes(t),
  ),
};
