import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { posix } from 'node:path';

const SKIP_FILES = new Set(['INDEX.md', 'LINKS.md', '.gitkeep', 'inbox.md', 'journal.md', 'log.md', 'decisions.md', 'hot.md']);

/**
 * Walk memory dir, return relative paths to all .md files (skipping operational files).
 * @param {string} dir - absolute directory to walk
 * @param {string} base - root base for relative paths
 * @returns {string[]}
 */
function walkMemory(dir, base = dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (SKIP_FILES.has(name)) continue;
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      out.push(...walkMemory(full, base));
    } else if (name.endsWith('.md')) {
      out.push(relative(base, full).split(/[\\/]/).join('/'));
    }
  }
  return out;
}

/**
 * Parse LINKS.md table rows into an array of { from, to } edges.
 * Handles the pipe-delimited table format: | from | to | context |
 * @param {string} content
 * @returns {{ from: string, to: string }[]}
 */
function parseLinksTable(content) {
  const edges = [];
  for (const line of content.split('\n')) {
    // Skip header and separator rows
    if (!line.startsWith('|')) continue;
    if (/^\|\s*[-:]+\s*\|/.test(line)) continue;
    if (/^\|\s*From\s*\|/i.test(line)) continue;
    const cols = line.split('|').map(s => s.trim()).filter((_, i) => i > 0 && _ !== '');
    if (cols.length < 2) continue;
    const [from, to] = cols;
    if (from && to && from.endsWith('.md') && to.endsWith('.md')) {
      edges.push({ from, to });
    }
  }
  return edges;
}

/**
 * Build entity → files map from LINKS.md edges.
 * The "entity" here is the target file (the shared cross-reference target).
 * Files that both link to the same target are considered to share a cross-reference.
 *
 * Additionally, files that link TO each other directly are paired.
 *
 * @param {{ from: string, to: string }[]} edges
 * @returns {Map<string, Set<string>>} entity (target) → set of files that reference it
 */
function buildEntityMap(edges) {
  const map = new Map();
  for (const { from, to } of edges) {
    if (!map.has(to)) map.set(to, new Set());
    map.get(to).add(from);
    // Also include the target itself so that if a file is referenced, it's in the set
    map.get(to).add(to);
  }
  return map;
}

/**
 * Extract the sub-tree prefix from a memory-relative path.
 * e.g. "profile/identity.md" → "profile"
 *      "knowledge/medical/health.md" → "knowledge/medical"
 *      "tasks.md" → "" (top-level)
 * @param {string} relPath
 * @returns {string}
 */
function subTree(relPath) {
  const parts = relPath.split('/');
  if (parts.length <= 1) return '';
  // Return directory part (all but last segment)
  return parts.slice(0, -1).join('/');
}

/**
 * Generate candidate audit pairs from LINKS.md cross-references + same-sub-tree files.
 *
 * Algorithm:
 * 1. Parse LINKS.md → entity → [files] map
 * 2. For each entity with ≥2 referencing files, emit C(n,2) pairs
 * 3. Also emit pairs of files in the same sub-tree
 * 4. Dedupe (sort each pair tuple alphabetically, then dedupe by tuple)
 * 5. Sort by max(mtime) of the two files, descending
 * 6. Return top N (default 20)
 *
 * @param {string} workspaceDir - absolute path to workspace root (contains user-data/)
 * @param {{ maxPairs?: number }} opts
 * @returns {[string, string][]} array of [fileA, fileB] pairs (memory-relative paths)
 */
export function generateAuditPairs(workspaceDir, opts = {}) {
  const maxPairs = opts.maxPairs ?? 20;
  const memoryDir = join(workspaceDir, 'user-data', 'memory');

  // Get all memory files with their mtimes
  const files = walkMemory(memoryDir);
  const mtimeMap = new Map();
  for (const f of files) {
    try {
      const st = statSync(join(memoryDir, f));
      mtimeMap.set(f, st.mtimeMs);
    } catch {
      mtimeMap.set(f, 0);
    }
  }

  const candidates = new Set(); // stringified "a|b" tuples (a < b alphabetically)

  // --- Step 1+2: LINKS.md-driven pairs ---
  const linksPath = join(memoryDir, 'LINKS.md');
  if (existsSync(linksPath)) {
    const linksContent = readFileSync(linksPath, 'utf-8');
    const edges = parseLinksTable(linksContent);
    const entityMap = buildEntityMap(edges);

    for (const [, fileSet] of entityMap) {
      const arr = [...fileSet].sort();
      if (arr.length < 2) continue;
      for (let i = 0; i < arr.length; i++) {
        for (let j = i + 1; j < arr.length; j++) {
          const a = arr[i], b = arr[j];
          // Only include pairs where both files actually exist in the workspace
          if (mtimeMap.has(a) && mtimeMap.has(b)) {
            candidates.add(`${a}|${b}`);
          }
        }
      }
    }
  }

  // --- Step 3: Same-sub-tree pairs ---
  const treeMap = new Map(); // subtree → [files]
  for (const f of files) {
    const tree = subTree(f);
    if (tree === '') continue; // skip top-level flat files
    if (!treeMap.has(tree)) treeMap.set(tree, []);
    treeMap.get(tree).push(f);
  }
  for (const [, treeFiles] of treeMap) {
    const sorted = [...treeFiles].sort();
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        candidates.add(`${sorted[i]}|${sorted[j]}`);
      }
    }
  }

  // --- Step 4: Dedupe already done via Set ---
  // Parse back to pairs
  const pairs = [...candidates].map(k => k.split('|'));

  // --- Step 5: Sort by max(mtime) descending ---
  pairs.sort((pA, pB) => {
    const mA = Math.max(mtimeMap.get(pA[0]) ?? 0, mtimeMap.get(pA[1]) ?? 0);
    const mB = Math.max(mtimeMap.get(pB[0]) ?? 0, mtimeMap.get(pB[1]) ?? 0);
    return mB - mA;
  });

  // --- Step 6: Return top N ---
  return pairs.slice(0, maxPairs);
}
