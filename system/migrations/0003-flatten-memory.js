import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync, renameSync } from 'node:fs';
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

function relocateTrips(workspaceDir, memDir) {
  const tripsDir = join(workspaceDir, 'user-data/trips');
  if (!existsSync(tripsDir)) return;
  const eventsDir = join(memDir, 'events');
  mkdirSync(eventsDir, { recursive: true });
  for (const name of readdirSync(tripsDir)) {
    const src = join(tripsDir, name);
    const dst = join(eventsDir, name);
    renameSync(src, dst);
    if (name.endsWith('.md')) {
      const content = readFileSync(dst, 'utf-8');
      const { frontmatter, body } = parseFrontmatter(content);
      if (!frontmatter.description) {
        const titleMatch = body.match(/^#\s+(.+)$/m);
        const title = titleMatch ? titleMatch[1] : name.replace(/\.md$/, '');
        const desc = inferDescription(title, body) || title;
        writeFileSync(dst, stringifyFrontmatter({ description: desc }, body));
      }
    }
  }
  rmSync(tripsDir, { recursive: true, force: true });
}

const FLAT_DESCRIPTIONS = {
  'inbox.md': 'Quick-capture buffer; Dream routes from here',
  'journal.md': 'Append-only daily reflections',
  'tasks.md': 'Active tasks grouped by category',
  'decisions.md': 'Append-only decision log',
  'self-improvement.md': 'Corrections, preferences, session handoff, calibration',
};

function ensureFlatFrontmatter(memDir) {
  for (const [name, desc] of Object.entries(FLAT_DESCRIPTIONS)) {
    const p = join(memDir, name);
    if (!existsSync(p)) continue;
    const content = readFileSync(p, 'utf-8');
    const { frontmatter, body } = parseFrontmatter(content);
    if (frontmatter.description) continue;
    writeFileSync(p, stringifyFrontmatter({ description: desc }, body));
  }
}

function deleteSidecarTree(memDir) {
  const idxDir = join(memDir, 'index');
  if (existsSync(idxDir)) rmSync(idxDir, { recursive: true, force: true });
}

export async function up({ workspaceDir, helpers, opts = {} }) {
  const interactive = opts.interactive ?? true;
  const memDir = join(workspaceDir, 'user-data/memory');

  splitMonolith(join(memDir, 'knowledge.md'), 'knowledge', { interactive });
  splitMonolith(join(memDir, 'profile.md'), 'profile', { interactive });
  relocateTrips(workspaceDir, memDir);
  deleteSidecarTree(memDir);
  ensureFlatFrontmatter(memDir);
}
