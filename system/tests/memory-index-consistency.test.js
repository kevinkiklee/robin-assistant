import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter } from '../scripts/lib/memory-index.js';
import { checkMemoryIndex } from '../scripts/regenerate-memory-index.js';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const skeletonMem = join(repoRoot, 'system/skeleton/memory');

function walk(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === 'INDEX.md' || name === '.gitkeep') continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full, base));
    else if (name.endsWith('.md')) out.push(relative(base, full).split(/[\\/]/).join('/'));
  }
  return out;
}

test('every skeleton memory file has description frontmatter', () => {
  if (!existsSync(skeletonMem)) return;
  const files = walk(skeletonMem);
  const missing = [];
  for (const f of files) {
    const { frontmatter } = parseFrontmatter(readFileSync(join(skeletonMem, f), 'utf-8'));
    if (!frontmatter.description) missing.push(f);
  }
  assert.deepEqual(missing, [], `files missing description: ${missing.join(', ')}`);
});

test('skeleton INDEX.md is up to date', () => {
  if (!existsSync(skeletonMem) || !existsSync(join(skeletonMem, 'INDEX.md'))) return;
  assert.equal(checkMemoryIndex(skeletonMem), true);
});
