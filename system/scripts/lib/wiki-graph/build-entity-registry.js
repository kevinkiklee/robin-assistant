import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { isExcludedPath } from './exclusions.js';

const REGISTRY_SKIP_PREFIXES = [
  'archive/',
  'quarantine/',
  'knowledge/sources/',
  'knowledge/conversations/',
];

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/;

function shouldSkipForRegistry(relPath) {
  if (isExcludedPath(relPath)) return true;
  return REGISTRY_SKIP_PREFIXES.some(p => relPath.startsWith(p));
}

async function* walkMd(root, base = root) {
  const entries = await readdir(root, { withFileTypes: true });
  for (const e of entries) {
    const full = join(root, e.name);
    if (e.isDirectory()) {
      yield* walkMd(full, base);
    } else if (e.isFile() && e.name.endsWith('.md')) {
      yield relative(base, full).split(/[\\/]/).join('/');
    }
  }
}

// Quote-aware splitter for inline YAML arrays. Treats commas inside double or
// single quotes as part of the value rather than separators. Adequate for the
// frontmatter shapes Robin uses; not a full YAML parser.
function splitInlineArray(inner) {
  const out = [];
  let buf = '';
  let quote = null;
  for (let i = 0; i < inner.length; i += 1) {
    const c = inner[i];
    if (quote) {
      if (c === quote) quote = null;
      else buf += c;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === ',') {
      out.push(buf.trim());
      buf = '';
    } else {
      buf += c;
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out.filter(Boolean);
}

// Local hand-rolled frontmatter reader. Diverges from the canonical
// `lib/memory-index.js` parseFrontmatter in two ways the registry needs:
//   1. Tolerates CRLF line endings.
//   2. Strips per-element quotes from inline arrays so aliases survive
//      round-trips through stringifyFrontmatter (which emits unquoted joins).
// Kept local rather than extending the canonical parser to avoid a wider
// refactor; deduplication is a deliberate-debt item.
function parseFrontmatter(content) {
  const m = content.match(FRONTMATTER_RE);
  if (!m) return null;
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.+)$/);
    if (!kv) continue;
    const key = kv[1];
    let val = kv[2].trim();
    if (val.startsWith('[') && val.endsWith(']')) {
      val = splitInlineArray(val.slice(1, -1));
    } else {
      val = val.replace(/^["']|["']$/g, '');
    }
    fm[key] = val;
  }
  return fm;
}

function normAlias(s) {
  return s.normalize('NFC').toLowerCase();
}

export async function buildEntityRegistry(workspaceDir) {
  const memoryRoot = join(workspaceDir, 'user-data', 'memory');
  const byPath = new Map();
  const byAlias = new Map();

  for await (const relPath of walkMd(memoryRoot)) {
    if (shouldSkipForRegistry(relPath)) continue;
    const content = await readFile(join(memoryRoot, relPath), 'utf-8');
    const fm = parseFrontmatter(content);
    if (!fm || !fm.canonical) continue;
    if (fm.trust === 'untrusted' || fm['trust-source']) continue;

    const canonical = String(fm.canonical);
    const aliasesRaw = Array.isArray(fm.aliases) ? fm.aliases : [];
    const aliases = Array.from(new Set([canonical, ...aliasesRaw]));

    byPath.set(relPath, { canonical, aliases });

    for (const a of aliases) {
      const key = normAlias(a);
      if (byAlias.has(key)) {
        const prev = byAlias.get(key);
        throw new Error(
          `wiki-graph: alias collision on "${a}": ${prev.path} and ${relPath}`
        );
      }
      byAlias.set(key, { canonical, path: relPath, aliases });
    }
  }

  return { byPath, byAlias };
}
