import rehypeParse from 'rehype-parse';
import { unified } from 'unified';

/**
 * Plain-text rendering of an HTML document for recall indexing: the <title>
 * and meta description as a header, then the visible body text with block
 * boundaries kept as newlines and table cells joined by " | ". CSS, scripts
 * and SVG geometry are dropped — they're bytes to embed, not knowledge.
 */

interface Node {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: Node[];
}

const SKIP = new Set(['head', 'style', 'script', 'noscript', 'template', 'svg']);
const BLOCK = new Set([
  'p',
  'div',
  'section',
  'article',
  'header',
  'footer',
  'main',
  'aside',
  'nav',
  'ul',
  'ol',
  'li',
  'table',
  'thead',
  'tbody',
  'tr',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'blockquote',
  'pre',
  'figure',
  'figcaption',
  'details',
  'summary',
  'dl',
  'dt',
  'dd',
  'hr',
]);

function find(node: Node, pred: (n: Node) => boolean): Node | null {
  if (pred(node)) return node;
  for (const c of node.children ?? []) {
    const hit = find(c, pred);
    if (hit) return hit;
  }
  return null;
}

function rawText(node: Node): string {
  if (node.type === 'text') return node.value ?? '';
  return (node.children ?? []).map(rawText).join('');
}

function render(node: Node, out: string[]): void {
  if (node.type === 'text') {
    out.push((node.value ?? '').replace(/\s+/g, ' '));
    return;
  }
  if (node.type !== 'element' && node.type !== 'root') return;
  const tag = node.tagName ?? '';
  if (SKIP.has(tag)) return;
  const heading = /^h([1-6])$/.exec(tag);
  if (BLOCK.has(tag)) out.push('\n');
  if (heading) out.push(`${'#'.repeat(Number(heading[1]))} `);
  if (tag === 'li') out.push('- ');
  if (tag === 'td' || tag === 'th') out.push(' | ');
  for (const c of node.children ?? []) render(c, out);
  // Inline boundaries (and <br>, which splits table rows as a newline) become a
  // space, so CSS-block labels like <b>Flight out</b>Booked don't fuse.
  out.push(BLOCK.has(tag) ? '\n' : ' ');
}

export function htmlToText(html: string): string {
  const tree = unified().use(rehypeParse).parse(html) as unknown as Node;
  const title = find(tree, (n) => n.tagName === 'title');
  const desc = find(
    tree,
    (n) => n.tagName === 'meta' && String(n.properties?.name ?? '').toLowerCase() === 'description',
  );
  const out: string[] = [];
  const t = title ? rawText(title).trim() : '';
  if (t) out.push(`# ${t}\n`);
  const d = desc?.properties?.content;
  if (typeof d === 'string' && d.trim()) out.push(`${d.trim()}\n`);
  render(tree, out);
  return out
    .join('')
    .split('\n')
    .map((line) =>
      line
        .replace(/^\s*\|\s*/, '')
        .replace(/\s{2,}/g, ' ')
        .trim(),
    )
    .filter((line, i, all) => line !== '' || (i > 0 && all[i - 1] !== ''))
    .join('\n')
    .trim();
}
