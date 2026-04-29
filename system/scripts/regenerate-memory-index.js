import { readdirSync, readFileSync, writeFileSync, statSync, existsSync, renameSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter } from './lib/memory-index.js';

const SKIP_NAMES = new Set(['INDEX.md', 'LINKS.md', 'log.md', 'hot.md', '.gitkeep']);
// Directories with their own INDEX.md become a single row in the parent INDEX
// rather than expanding to per-file rows. Keeps the main INDEX bounded as
// sub-trees grow.
const SUB_INDEXED_BARRIERS = ['archive'];

function walk(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (SKIP_NAMES.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      const subIndex = join(full, 'INDEX.md');
      const isBarrier = SUB_INDEXED_BARRIERS.includes(name);
      if (existsSync(subIndex) || isBarrier) {
        // Emit just the sub-index path; do not descend.
        if (existsSync(subIndex)) {
          out.push(relative(base, subIndex).split(/[\\/]/).join('/'));
        }
        continue;
      }
      out.push(...walk(full, base));
    } else if (name.endsWith('.md')) {
      out.push(relative(base, full).split(/[\\/]/).join('/'));
    }
  }
  return out;
}

export function generateMemoryIndex(memoryDir) {
  if (!existsSync(memoryDir)) throw new Error(`memory dir not found: ${memoryDir}`);
  const paths = walk(memoryDir).sort();
  const missing = [];
  const rows = [];
  for (const p of paths) {
    const content = readFileSync(join(memoryDir, p), 'utf-8');
    const { frontmatter } = parseFrontmatter(content);
    if (!frontmatter.description) {
      missing.push(p);
      continue;
    }
    rows.push(`| ${p} | ${frontmatter.description} |`);
  }
  if (missing.length > 0) {
    throw new Error(`memory files missing description frontmatter:\n  ${missing.join('\n  ')}`);
  }
  const lines = [
    '# Memory Index',
    '',
    "Robin's memory tree. Read this to decide which file to open. Generated — do not edit by hand.",
    '',
    "| path | what's in it |",
    '|------|--------------|',
    ...rows,
    '',
  ];
  return lines.join('\n');
}

export function writeMemoryIndex(memoryDir) {
  const out = generateMemoryIndex(memoryDir);
  const path = join(memoryDir, 'INDEX.md');
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, out);
  renameSync(tmp, path);
}

export function checkMemoryIndex(memoryDir) {
  const expected = generateMemoryIndex(memoryDir);
  const actualPath = join(memoryDir, 'INDEX.md');
  if (!existsSync(actualPath)) return false;
  const actual = readFileSync(actualPath, 'utf-8');
  return actual === expected;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const memoryDir = fileURLToPath(new URL('../../user-data/memory', import.meta.url));
  if (process.argv.includes('--check')) {
    if (!checkMemoryIndex(memoryDir)) {
      console.error('memory/INDEX.md is out of date. Run regenerate-memory-index.js to fix.');
      process.exit(1);
    }
    console.log('memory/INDEX.md is up to date.');
  } else {
    writeMemoryIndex(memoryDir);
  }
}
