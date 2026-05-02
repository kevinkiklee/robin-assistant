// related-heuristic.js — Pass 3 logic for densify-wiki.
// Builds entity-mention matrix, generates cross-directory pairs with
// sub-tree dampening + super-hub filter, writes symmetric `related:`
// edges with hand-curated preservation.

const FM_BLOCK_RE = /^---\n[\s\S]*?\n---\n?/;
const CODE_FENCE_RE = /```[\s\S]*?```/g;

function stripIgnoredRegions(body) {
  return body.replace(FM_BLOCK_RE, '').replace(CODE_FENCE_RE, '');
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const DEFAULT_EXCLUDED_PREFIXES = [
  'archive/',
  'quarantine/',
  'knowledge/conversations/',
  'knowledge/calendar/events/',
  'knowledge/finance/lunch-money/transactions/',
];

function parentDir(relPath) {
  const parts = relPath.split('/');
  return parts.slice(0, -1).join('/');
}

function isExcluded(relPath, excluded) {
  return excluded.some(prefix => relPath.startsWith(prefix));
}

export function generatePairs(matrix, { excludedSubtrees } = {}) {
  const excluded = excludedSubtrees ?? DEFAULT_EXCLUDED_PREFIXES;
  const files = [...matrix.entries()].filter(([rel]) => !isExcluded(rel, excluded));
  const pairs = [];
  for (let i = 0; i < files.length; i++) {
    for (let j = i + 1; j < files.length; j++) {
      const [aPath, aSet] = files[i];
      const [bPath, bSet] = files[j];
      if (parentDir(aPath) === parentDir(bPath)) continue;
      const shared = new Set();
      for (const slug of aSet) {
        if (bSet.has(slug)) shared.add(slug);
      }
      if (shared.size === 0) continue;
      pairs.push({ a: aPath, b: bPath, sharedEntities: shared });
    }
  }
  return pairs;
}

export { DEFAULT_EXCLUDED_PREFIXES };

function isSelfReference(relPath, slug) {
  // Avoid a page counting itself as a mention.
  // Works for both simple slugs (jake-lee) and path slugs (profile/people/jake-lee).
  const withoutExt = relPath.replace(/\.md$/, '');
  return withoutExt === slug || withoutExt.endsWith(`/${slug}`);
}

export function buildMentionMatrix(filesMap, registry) {
  const matrix = new Map();
  for (const [relPath, body] of filesMap) {
    const cleaned = stripIgnoredRegions(body);
    const found = new Set();
    for (const { slug, aliases } of registry) {
      if (isSelfReference(relPath, slug)) continue;
      for (const alias of aliases) {
        const re = new RegExp(`\\b${escapeRegex(alias)}\\b`, 'i');
        if (re.test(cleaned)) {
          found.add(slug);
          break;
        }
      }
    }
    matrix.set(relPath, found);
  }
  return matrix;
}
