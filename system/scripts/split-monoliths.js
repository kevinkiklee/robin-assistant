#!/usr/bin/env node
// Interactive splitter for knowledge.md and profile.md monoliths.
// Prompts the user to mark each level-2 heading as a domain root (becomes a topic file)
// or a child (preserved as a `## ` subsection inside the preceding root's file).
//
// Usage: `npm run split-monoliths` — must be run from a real interactive terminal.
// Piped stdin is unreliable with Node 24's readline/promises; the script's
// pure logic (executeSplit, repairCrossReferences) is exercised by unit tests
// in system/tests/split-monoliths.test.js.

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, posix, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import {
  parseFrontmatter,
  stringifyFrontmatter,
  parseHeadings,
  sectionSizes,
  slugify,
  disambiguateSlug,
  rewriteLinks,
} from './lib/memory-index.js';
import { writeMemoryIndex } from './regenerate-memory-index.js';

const POINTER_RE = /[ \t]*<!--\s*id:[^>]+-->/g;
const CHILD_DEFAULT_THRESHOLD = 50; // sections smaller than this default to "child"

function inferDescription(title, body) {
  for (const line of body.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    return t.replace(/[*_`]/g, '').replace(/^[-*+]\s+/, '').slice(0, 80);
  }
  return title;
}

async function promptRootChild(rl, heading, ownSize, suggested) {
  const tag = suggested === 'root' ? '[R]oot/c]hild' : 'r]oot/[C]hild';
  // Print the heading line separately so the readline prompt is single-line
  // (multi-line prompts hang on piped stdin in Node 24's readline/promises).
  console.log(`  line ${heading.line} (${ownSize} lines) ## ${heading.title}`);
  const ans = (await rl.question(
    `    ${tag} (default ${suggested[0].toUpperCase()}, s=skip remaining): `
  )).trim().toLowerCase();
  if (ans === '' || ans === suggested[0]) return suggested;
  if (ans === 'r') return 'root';
  if (ans === 'c') return 'child';
  if (ans === 's') return 'auto';
  return suggested;
}

async function classifyHeadings(rl, headings, sizes, fileName) {
  console.log(`\n=== Classifying ${fileName} (${headings.filter(h => h.level === 2).length} level-2 headings) ===`);
  console.log('For each heading, mark as root (own topic file) or child (sub-section of preceding root).');
  console.log('Default is suggested in [brackets]. Press Enter to accept default. Type "s" to auto-accept all remaining.\n');

  const decisions = [];
  let autoMode = false;
  for (const h of headings) {
    if (h.level !== 2) continue;
    const ownSize = sizes.get(h.line) ?? 0;
    const suggested = (decisions.length === 0 || ownSize >= CHILD_DEFAULT_THRESHOLD) ? 'root' : 'child';
    let role;
    if (autoMode) {
      role = suggested;
    } else {
      role = await promptRootChild(rl, h, ownSize, suggested);
      if (role === 'auto') {
        autoMode = true;
        role = suggested;
      }
    }
    decisions.push({ heading: h, role, ownSize });
  }
  return decisions;
}

function showPlan(decisions, fileName, area) {
  const roots = decisions.filter(d => d.role === 'root');
  console.log(`\nPlan for ${fileName} → ${area}/:`);
  let currentRoot = null;
  for (const d of decisions) {
    if (d.role === 'root') {
      currentRoot = slugify(d.heading.title);
      console.log(`  ROOT  ${area}/${currentRoot}.md  ← "${d.heading.title}" (${d.ownSize} lines)`);
    } else {
      console.log(`  child   "${d.heading.title}" (${d.ownSize} lines) → ${currentRoot ?? '(orphaned)'}.md`);
    }
  }
  return roots.length;
}

export function executeSplit(filePath, area, decisions) {
  const content = readFileSync(filePath, 'utf-8');
  const { body } = parseFrontmatter(content);
  const lines = body.split('\n');

  // Build root segments: start = root.line - 1, end = next root's line - 1 (or EOF).
  const roots = decisions.filter(d => d.role === 'root').map(d => d.heading);
  const used = new Set();
  const emitted = [];

  for (let i = 0; i < roots.length; i++) {
    const start = roots[i].line - 1;
    const end = (i + 1 < roots.length) ? roots[i + 1].line - 1 : lines.length;
    const sectionLines = lines.slice(start, end);
    const sectionBody = sectionLines.join('\n').replace(POINTER_RE, '').replace(/\n{3,}/g, '\n\n');
    const slug = disambiguateSlug(slugify(roots[i].title), used);
    used.add(slug);
    const description = inferDescription(roots[i].title, sectionBody);
    const out = stringifyFrontmatter({ description }, sectionBody);
    const dest = join(dirname(filePath), area, `${slug}.md`);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, out.endsWith('\n') ? out : out + '\n');
    emitted.push({ slug, path: dest, oldTitle: roots[i].title });
  }
  rmSync(filePath);
  return emitted;
}

export function repairCrossReferences(memDir, renames) {
  if (renames.size === 0) return;
  function walk(dir) {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) { walk(full); continue; }
      if (!name.endsWith('.md') || name === 'INDEX.md') continue;
      const rel = posix.relative(memDir, full).split(/[\\/]/).join('/');
      const content = readFileSync(full, 'utf-8');
      const out = rewriteLinks(content, renames, rel);
      if (out !== content) writeFileSync(full, out);
    }
  }
  walk(memDir);
}

export async function splitMonoliths(workspaceDir) {
  const memDir = join(workspaceDir, 'user-data/memory');
  const targets = [
    { fileName: 'knowledge.md', area: 'knowledge' },
    { fileName: 'profile.md', area: 'profile' },
  ];

  const rl = createInterface({ input, output });
  const renames = new Map();
  let totalEmitted = 0;

  try {
    for (const { fileName, area } of targets) {
      const filePath = join(memDir, fileName);
      if (!existsSync(filePath)) {
        console.log(`(${fileName} not present — skipping)`);
        continue;
      }
      const content = readFileSync(filePath, 'utf-8');
      const { body } = parseFrontmatter(content);
      const headings = parseHeadings(body);
      const sizes = sectionSizes(body, 2);

      const decisions = await classifyHeadings(rl, headings, sizes, fileName);
      const rootCount = showPlan(decisions, fileName, area);

      const confirm = (await rl.question(`\nProceed with ${rootCount} topic files for ${fileName}? [y/N]: `)).trim().toLowerCase();
      if (confirm !== 'y' && confirm !== 'yes') {
        console.log(`Skipped ${fileName}.`);
        continue;
      }

      const emitted = executeSplit(filePath, area, decisions);
      console.log(`Wrote ${emitted.length} topic files under ${area}/.`);
      totalEmitted += emitted.length;
      if (emitted.length > 0) {
        renames.set(fileName, posix.relative(memDir, emitted[0].path).split(/[\\/]/).join('/'));
      }
    }
  } finally {
    rl.close();
  }

  if (renames.size > 0) {
    console.log('Repairing cross-references...');
    repairCrossReferences(memDir, renames);
  }
  if (totalEmitted > 0) {
    console.log('Regenerating INDEX.md...');
    writeMemoryIndex(memDir);
  }
  console.log('Done.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // Use cwd so the script operates on the user's workspace when invoked via npm run.
  // Falls back to the package root if cwd doesn't have user-data/.
  const cwd = process.cwd();
  const fallback = fileURLToPath(new URL('../..', import.meta.url));
  const workspaceDir = existsSync(join(cwd, 'user-data')) ? cwd : fallback;
  await splitMonoliths(workspaceDir);
}
