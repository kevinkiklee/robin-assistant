import matter from 'gray-matter';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import rehypeRaw from 'rehype-raw';
import rehypeSlug from 'rehype-slug';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import rehypeStringify from 'rehype-stringify';

export function extractFrontmatter(src) {
  const parsed = matter(src);
  return { frontmatter: parsed.data || {}, body: parsed.content };
}

export function normalizeMarkdown(src) {
  let s = src;
  if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
  s = s.replace(/\r\n/g, '\n');
  return s;
}

// `clobberPrefix: ''` keeps heading IDs as-is (e.g. `id="my-section"` instead
// of the default `id="user-content-my-section"`). The default is a security
// hardening for content embedded inside another page's DOM — irrelevant for
// us since published pages are top-level documents, and breaking it means
// internal anchor links (e.g. `[link](#my-section)`) work without a prefix.
export const sanitizeSchema = {
  ...defaultSchema,
  clobberPrefix: '',
  clobber: (defaultSchema.clobber || []).filter((a) => a !== 'id'),
  protocols: {
    ...defaultSchema.protocols,
    src: ['http', 'https', 'data'],
    href: ['http', 'https', 'mailto', 'tel'],
  },
  attributes: {
    ...defaultSchema.attributes,
    '*': [
      ...(defaultSchema.attributes?.['*'] || []).filter((a) => !String(a).startsWith('on')),
      'id', 'className',
    ],
    a: [...(defaultSchema.attributes?.a || []), 'rel', 'target'],
    img: [...(defaultSchema.attributes?.img || []), 'alt', 'src', 'title', 'width', 'height', 'loading'],
  },
  tagNames: (defaultSchema.tagNames || []).filter(
    (t) => !['script', 'iframe', 'object', 'embed', 'form', 'base'].includes(t),
  ),
};

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeRaw)
  .use(rehypeSlug)
  .use(rehypeSanitize, sanitizeSchema)
  .use(rehypeStringify);

export async function markdownToHtml(body) {
  const file = await processor.process(body);
  return String(file);
}
