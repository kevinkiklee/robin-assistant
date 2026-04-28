import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import {
  parseFrontmatter,
  stringifyFrontmatter,
  parseHeadings,
  proposeDomainRoots,
  sectionSizes,
  slugify,
  disambiguateSlug,
} from '../scripts/lib/memory-index.js';

export const id = '0003-flatten-memory';
export const description = 'Flatten memory into topic folders, drop sidecars, consolidate trips into events';

const POINTER_RE = /[ \t]*<!--\s*id:[^>]+-->/g;

function stripPointers(s) {
  return s.replace(POINTER_RE, '');
}

function inferDescription(title, body) {
  const lines = body.split('\n');
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith('#')) continue;
    return t.replace(/[*_`]/g, '').replace(/^[-*+]\s+/, '').slice(0, 80);
  }
  return title;
}

function splitMonolith(filePath, area, opts) {
  if (!existsSync(filePath)) return [];
  const content = readFileSync(filePath, 'utf-8');
  const { body } = parseFrontmatter(content);
  const lines = body.split('\n');
  const headings = parseHeadings(body);
  const sizes = sectionSizes(body, 2);

  // In non-interactive mode, treat every level-2 heading as a root for predictability.
  // Interactive mode prompts the user to demote some to children (Task 17 stub).
  const proposed = opts.interactive
    ? proposeDomainRoots(headings, sizes)
    : headings.filter(h => h.level === 2);
  if (opts.interactive) {
    console.log(`[0003] Proposing domain roots for ${filePath}:`);
    for (const r of proposed) console.log(`  - ${r.title} (line ${r.line})`);
  }
  const roots = proposed;
  if (roots.length === 0) return [];

  const used = new Set();
  const emitted = [];
  for (let i = 0; i < roots.length; i++) {
    const start = roots[i].line - 1;
    const end = (i + 1 < roots.length) ? roots[i + 1].line - 1 : lines.length;
    const sectionLines = lines.slice(start, end);
    const sectionBody = stripPointers(sectionLines.join('\n')).replace(/\n{3,}/g, '\n\n');
    const slug = disambiguateSlug(slugify(roots[i].title), used);
    used.add(slug);
    const description = inferDescription(roots[i].title, sectionBody);
    const out = stringifyFrontmatter({ description }, sectionBody);
    const dest = join(dirname(filePath), area, `${slug}.md`);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, out.endsWith('\n') ? out : out + '\n');
    emitted.push({ area, slug, path: dest, oldTitle: roots[i].title });
  }
  rmSync(filePath);
  return emitted;
}

export async function up({ workspaceDir, helpers, opts = {} }) {
  const interactive = opts.interactive ?? true;
  const memDir = join(workspaceDir, 'user-data/memory');

  splitMonolith(join(memDir, 'knowledge.md'), 'knowledge', { interactive });
  splitMonolith(join(memDir, 'profile.md'), 'profile', { interactive });
}
