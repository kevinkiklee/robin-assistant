// Sentence-hash index for cycle-1b's outbound taint check.
//
// Builds a Set of FNV-1a-64 hashes covering every "sentence" inside files
// marked `trust: untrusted` (or `untrusted-mixed`). Outbound write tools
// hash sentences in their proposed content and refuse if any match.
//
// The index lives at user-data/runtime/state/cache/untrusted-index.json. Sync writers
// update it via updateIndexForFile() after each atomicWrite. Outbound
// policy reads the index via loadOrRefreshIndex(), which stat-checks every
// tracked source and rebuilds entries whose mtime has advanced.

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

const INDEX_REL = 'user-data/runtime/state/cache/untrusted-index.json';

// FNV-1a 64-bit hash. Returns a 16-char lowercase hex string.
export function fnv1a64(s) {
  let h_lo = 0x84222325 >>> 0;
  let h_hi = 0xcbf29ce4 >>> 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h_lo ^= c;
    // Multiply by 0x100000001b3 = (0x100 << 32) | 0x000001b3
    // 64-bit mul in two 32-bit halves.
    const prime_lo = 0x000001b3 >>> 0;
    const prime_hi = 0x00000100 >>> 0;
    const lo_lo = (h_lo & 0xffff) * (prime_lo & 0xffff);
    const lo_hi = (h_lo >>> 16) * (prime_lo & 0xffff) + ((lo_lo >>> 16) & 0xffff);
    const hi_lo = (h_lo & 0xffff) * (prime_lo >>> 16) + (lo_hi & 0xffff);
    const hi_hi = (h_lo >>> 16) * (prime_lo >>> 16) + (lo_hi >>> 16) + (hi_lo >>> 16);
    let new_lo = ((hi_lo & 0xffff) << 16) | (lo_lo & 0xffff);
    let new_hi = (hi_hi & 0xffffffff) >>> 0;
    new_hi = (new_hi + h_hi * prime_lo + h_lo * prime_hi) >>> 0;
    h_lo = new_lo >>> 0;
    h_hi = new_hi >>> 0;
  }
  return (h_hi.toString(16).padStart(8, '0') + h_lo.toString(16).padStart(8, '0'));
}

// Normalize a sentence-shaped fragment for stable hashing. Lowercases, trims,
// strips trailing punctuation, and collapses whitespace. Both haystack indexing
// and outbound checking apply this normalization so paraphrase with different
// casing/spacing/trailing-punctuation still matches.
function normalizeSentence(s) {
  return s
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.!?,;:]+$/, '');
}

// Split text into normalized sentences for the haystack.
//
// Sentences shorter than 20 chars after normalization are dropped — too
// generic to be useful signal. We split on sentence terminators, paragraph
// breaks, list-item starts, table-cell boundaries, AND commas — the comma
// split lets us catch "Hello, <attacker payload sentence>." outbound text
// where the haystack sentence appears after a comma.
export function splitSentences(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  // Strip frontmatter and UNTRUSTED markers from text first; we hash the
  // content the agent would see, not the metadata.
  let body = text.replace(/^---\n[\s\S]*?\n---\n?/, '');
  body = body.replace(/<!--\s*UNTRUSTED-(START|END)[^>]*-->/g, '');

  // Split on sentence terminators, paragraph breaks, list-item starts,
  // table-cell boundaries, and commas-with-whitespace.
  const raw = body.split(/(?:[.!?]+\s+|\n\s*\n|\n\s*[-*]\s+|\||,\s+)/);
  const out = [];
  for (const piece of raw) {
    const s = normalizeSentence(piece);
    if (s.length < 20) continue;
    out.push(s);
  }
  return out;
}

function indexPath(workspaceDir) {
  return join(workspaceDir, INDEX_REL);
}

function emptyIndex() {
  return { version: 1, sources: {} };
}

function readIndex(workspaceDir) {
  const p = indexPath(workspaceDir);
  if (!existsSync(p)) return emptyIndex();
  try {
    const data = JSON.parse(readFileSync(p, 'utf-8'));
    if (typeof data !== 'object' || !data || !data.sources) return emptyIndex();
    return data;
  } catch {
    return emptyIndex();
  }
}

function writeIndex(workspaceDir, data) {
  const p = indexPath(workspaceDir);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(data, null, 2));
}

// Update the index for a single source file. Called by atomicWrite when
// opts.trust is set. relPath should be the in-workspace relative path.
export function updateIndexForFile(workspaceDir, relPath, content) {
  const data = readIndex(workspaceDir);
  const sentences = splitSentences(content);
  const fullPath = join(workspaceDir, relPath);
  const mtime = existsSync(fullPath) ? statSync(fullPath).mtimeMs : Date.now();
  // Store both sentences (for substring match) and hashes (for cheap dedup).
  data.sources[relPath] = { mtime, sentences, hashes: sentences.map(fnv1a64) };
  writeIndex(workspaceDir, data);
}

// Read the index; for every tracked source still on disk, stat-check it
// and rebuild that source's entry if mtime has advanced. Drops entries
// whose source file no longer exists.
//
// Returns { sources, allHashes: Set<string>, allSentences: Array<{sentence, source}> }.
export function loadOrRefreshIndex(workspaceDir) {
  const data = readIndex(workspaceDir);
  let mutated = false;

  for (const [relPath, entry] of Object.entries(data.sources)) {
    const fullPath = join(workspaceDir, relPath);
    if (!existsSync(fullPath)) {
      delete data.sources[relPath];
      mutated = true;
      continue;
    }
    const currentMtime = statSync(fullPath).mtimeMs;
    if (currentMtime > entry.mtime) {
      const content = readFileSync(fullPath, 'utf-8');
      const sentences = splitSentences(content);
      data.sources[relPath] = {
        mtime: currentMtime,
        sentences,
        hashes: sentences.map(fnv1a64),
      };
      mutated = true;
    } else if (!Array.isArray(entry.sentences)) {
      // Index built before sentence-storage upgrade — rebuild.
      const content = readFileSync(fullPath, 'utf-8');
      const sentences = splitSentences(content);
      data.sources[relPath] = {
        mtime: currentMtime,
        sentences,
        hashes: sentences.map(fnv1a64),
      };
      mutated = true;
    }
  }

  if (mutated) writeIndex(workspaceDir, data);

  const allHashes = new Set();
  const allSentences = [];
  for (const [path, entry] of Object.entries(data.sources)) {
    for (const h of (entry.hashes || [])) allHashes.add(h);
    for (const s of (entry.sentences || [])) allSentences.push({ sentence: s, source: path });
  }
  return { sources: data.sources, allHashes, allSentences };
}

// Find the first source file whose hashes contain the given hash.
// Used by outbound-policy to attribute a refusal to a source.
export function findSourceForHash(index, hash) {
  for (const [path, entry] of Object.entries(index.sources)) {
    if ((entry.hashes || []).includes(hash)) return path;
  }
  return null;
}

export const __test__ = { indexPath, readIndex, writeIndex };
