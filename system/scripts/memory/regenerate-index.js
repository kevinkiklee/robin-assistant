import { readdirSync, readFileSync, writeFileSync, statSync, existsSync, renameSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter } from './lib/memory-index.js';

const SKIP_NAMES = new Set(['INDEX.md', 'LINKS.md', 'log.md', 'hot.md', '.gitkeep']);
// Directories with their own INDEX.md become a single row in the parent INDEX
// rather than expanding to per-file rows. Keeps the main INDEX bounded as
// sub-trees grow.
const SUB_INDEXED_BARRIERS = ['archive'];

// "Where to look first" routing block — a hand-curated region inside the
// otherwise auto-regenerated INDEX.md. The regenerator preserves user edits
// between BEGIN/END markers; checkMemoryIndex ignores the marked region via
// stripRoutingBlock. Both functions must cooperate — touching one without
// the other breaks the invariant that user edits inside the markers don't
// fail consistency.
const MARKER_BEGIN = '<!-- BEGIN where-to-look-first -->';
const MARKER_END = '<!-- END where-to-look-first -->';

function escapeRegex(s) {
  return s.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
}

const DEFAULT_ROUTING_BLOCK = `${MARKER_BEGIN}
## Where to look first

Routing convention for memory files. Some paths below may not exist yet on a fresh install — that's expected; they're where new content of that kind goes.

| If the question is about… | Where it lives (or should be created) |
|---|---|
| A specific person | \`profile/relationships.md\`, or per-person files under \`profile/\` |
| A purchase or expense | \`knowledge/finance/transactions.md\` |
| A photo, camera, or lens | \`knowledge/photography-collection/INDEX.md\` |
| A trip or event | \`knowledge/events/INDEX.md\` |
| A subscription or recurring charge | \`knowledge/finance/subscriptions.md\` |
| A medical event or appointment | \`knowledge/medical/INDEX.md\` |
| Anything else with a clear topic | \`knowledge/<topic>/INDEX.md\`; otherwise the auto-table below |
${MARKER_END}`;

// Returns the first marker-delimited block from existing INDEX.md, or null
// if absent/malformed. If the user has accidentally duplicated the markers,
// only the first BEGIN→first END span is preserved (user-error, fail safe).
function extractRoutingBlock(existingText) {
  if (!existingText) return null;
  const startIdx = existingText.indexOf(MARKER_BEGIN);
  const endIdx = existingText.indexOf(MARKER_END);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) return null;
  return existingText.slice(startIdx, endIdx + MARKER_END.length);
}

function stripRoutingBlock(text) {
  return text.replace(
    new RegExp(`${escapeRegex(MARKER_BEGIN)}[\\s\\S]*?${escapeRegex(MARKER_END)}`),
    '<<ROUTING_BLOCK>>',
  );
}

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
  const existingPath = join(memoryDir, 'INDEX.md');
  const existing = existsSync(existingPath) ? readFileSync(existingPath, 'utf-8') : '';
  const routingBlock = extractRoutingBlock(existing) ?? DEFAULT_ROUTING_BLOCK;

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
    "Robin's memory tree. The \"Where to look first\" block below is hand-curated; the path table is auto-regenerated. Read both before opening a sub-tree.",
    '',
    routingBlock,
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
  return stripRoutingBlock(actual) === stripRoutingBlock(expected);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const memoryDir = fileURLToPath(new URL('../../../user-data/memory', import.meta.url));
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
