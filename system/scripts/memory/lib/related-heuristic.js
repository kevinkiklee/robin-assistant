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
