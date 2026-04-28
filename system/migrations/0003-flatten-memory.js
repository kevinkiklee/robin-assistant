import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { parseFrontmatter, stringifyFrontmatter } from '../scripts/lib/memory-index.js';
import { writeMemoryIndex } from '../scripts/regenerate-memory-index.js';

export const id = '0003-flatten-memory';
export const description = 'Drop sidecar index, relocate trips into events, add frontmatter — preserves knowledge.md and profile.md for interactive splitting';

const POINTER_RE = /[ \t]*<!--\s*id:[^>]+-->/g;

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

function ensureMonolithFrontmatter(memDir) {
  // knowledge.md and profile.md are preserved as monoliths until the user
  // runs the interactive splitter (`npm run split-monoliths`). Add description
  // frontmatter so they appear in INDEX.md.
  const monoliths = {
    'knowledge.md': 'Reference facts (monolith — run `npm run split-monoliths` to split into topic files)',
    'profile.md': 'Identity, personality, preferences, goals, people, routines (monolith — run `npm run split-monoliths` to split)',
  };
  for (const [name, desc] of Object.entries(monoliths)) {
    const p = join(memDir, name);
    if (!existsSync(p)) continue;
    const content = readFileSync(p, 'utf-8');
    const { frontmatter, body } = parseFrontmatter(content);
    if (frontmatter.description) continue;
    // Strip inline pointer IDs since the sidecar that referenced them is gone.
    const cleanBody = body.replace(POINTER_RE, '');
    writeFileSync(p, stringifyFrontmatter({ description: desc }, cleanBody));
  }
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

  // Phase 1 (this migration) — safe operations only:
  // - Drop the .idx.md sidecar tree
  // - Relocate user-data/trips/ → memory/events/ with frontmatter
  // - Add description frontmatter to flat files (inbox, decisions, journal, tasks, self-improvement)
  // - Add description frontmatter to knowledge.md and profile.md (preserved as monoliths)
  // - Generate INDEX.md
  //
  // Phase 2 (interactive, separate) — `npm run split-monoliths` lets the user
  // mark which level-2 headings in knowledge.md / profile.md are domain roots vs
  // children, then splits them into topic folders. This step is NOT auto-run because
  // the user's data uses level-2 headings for both roots AND sub-sections, so a
  // mechanical split would mis-place content.
  relocateTrips(workspaceDir, memDir);
  deleteSidecarTree(memDir);
  ensureFlatFrontmatter(memDir);
  ensureMonolithFrontmatter(memDir);

  if (interactive) {
    const monolithsExist = ['knowledge.md', 'profile.md'].some(n => existsSync(join(memDir, n)));
    if (monolithsExist) {
      console.log('[0003] knowledge.md and profile.md preserved as monoliths.');
      console.log('[0003] Run `npm run split-monoliths` to interactively split them into topic folders.');
    }
  }

  writeMemoryIndex(memDir);
}
