import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, basename } from 'node:path';
import { parseFrontmatter, stringifyFrontmatter } from '../scripts/lib/memory-index.js';
import { writeMemoryIndex } from '../scripts/regenerate-memory-index.js';

export const id = '0004-add-frontmatter-types';
export const description = 'Add type field to memory file frontmatter for wiki-style entity/concept typing';

const SKIP_NAMES = new Set(['INDEX.md', 'LINKS.md', 'log.md', 'hot.md', '.gitkeep']);

function inferType(relPath) {
  if (relPath.startsWith('knowledge/events/')) return 'event';
  if (relPath.startsWith('knowledge/sources/')) return 'source';
  if (relPath.startsWith('knowledge/conversations/')) return 'conversation';
  const name = basename(relPath, '.md');
  if (name.includes('snapshot')) return 'snapshot';
  return 'topic';
}

function walk(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (SKIP_NAMES.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...walk(full, base));
    } else if (name.endsWith('.md')) {
      out.push({ full, rel: relative(base, full).split(/[\\/]/).join('/') });
    }
  }
  return out;
}

export async function up({ workspaceDir }) {
  const memDir = join(workspaceDir, 'user-data/memory');
  if (!existsSync(memDir)) return;

  const files = walk(memDir);
  let updated = 0;

  for (const { full, rel } of files) {
    const content = readFileSync(full, 'utf-8');
    const { frontmatter, body } = parseFrontmatter(content);
    if (frontmatter.type) continue;
    if (!frontmatter.description) continue;

    frontmatter.type = inferType(rel);
    writeFileSync(full, stringifyFrontmatter(frontmatter, body));
    updated++;
  }

  writeMemoryIndex(memDir);

  if (updated > 0) {
    console.log(`[0004] Added type frontmatter to ${updated} files.`);
  }
}
