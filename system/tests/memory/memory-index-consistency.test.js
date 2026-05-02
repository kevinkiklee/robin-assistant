import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter } from '../../scripts/memory/lib/memory-index.js';
import { checkMemoryIndex } from '../../scripts/memory/regenerate-index.js';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const scaffoldMem = join(repoRoot, 'system/scaffold/memory');

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

test('every scaffold memory file has description frontmatter', () => {
  if (!existsSync(scaffoldMem)) return;
  const files = walk(scaffoldMem);
  const missing = [];
  for (const f of files) {
    const { frontmatter } = parseFrontmatter(readFileSync(join(scaffoldMem, f), 'utf-8'));
    if (!frontmatter.description) missing.push(f);
  }
  assert.deepEqual(missing, [], `files missing description: ${missing.join(', ')}`);
});

test('scaffold INDEX.md is up to date', () => {
  if (!existsSync(scaffoldMem) || !existsSync(join(scaffoldMem, 'INDEX.md'))) return;
  assert.equal(checkMemoryIndex(scaffoldMem), true);
});
