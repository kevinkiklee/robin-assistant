// alias-expander.js — Pass 1 logic for densify-wiki.
// Derives alias candidates from H1 + filename, applies filter chain,
// writes atomic frontmatter mutations.

const FRONTMATTER_RE = /^---\n[\s\S]*?\n---\n?/;
const H1_RE = /^#\s+(.+)$/m;

function stripFrontmatter(body) {
  return body.replace(FRONTMATTER_RE, '');
}

function titleCase(s) {
  return s
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export function deriveCandidates({ body, filename }) {
  const candidates = new Set();
  const afterFm = stripFrontmatter(body);
  const h1Match = afterFm.match(H1_RE);
  if (h1Match) {
    const h1 = h1Match[1].trim();
    if (h1) candidates.add(h1);
  }
  const stem = filename.replace(/\.md$/, '');
  const fromFilename = titleCase(stem);
  if (fromFilename) candidates.add(fromFilename);
  return [...candidates];
}

function tokenCount(s) {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

export function applyFilters(candidates, { existingAliases, inPassRegistry, stopList }) {
  const accepted = [];
  const rejected = [];
  const existingLower = new Set([...existingAliases].map(a => a.toLowerCase()));
  for (const c of candidates) {
    const lower = c.toLowerCase();
    const tokens = c.trim().split(/\s+/).filter(Boolean);
    if (tokens.some(t => t.length < 3)) {
      rejected.push({ candidate: c, reason: 'length-lt-3' });
      continue;
    }
    if (tokenCount(c) < 2) {
      rejected.push({ candidate: c, reason: 'single-token' });
      continue;
    }
    if (existingLower.has(lower)) {
      rejected.push({ candidate: c, reason: 'duplicate-self' });
      continue;
    }
    if (stopList.has(lower)) {
      rejected.push({ candidate: c, reason: 'stop-list' });
      continue;
    }
    if (inPassRegistry.has(c) || inPassRegistry.has(lower)) {
      rejected.push({ candidate: c, reason: `collision: ${inPassRegistry.get(c) ?? inPassRegistry.get(lower)}` });
      continue;
    }
    accepted.push(c);
  }
  return { accepted, rejected };
}

export const ENTITY_SHAPED_DIRS = [
  'profile/people/',
  'knowledge/service-providers/',
  'knowledge/projects/',
  'knowledge/locations/',
];

export function inEntityShapedDir(relPath) {
  const norm = relPath.replace(/\\/g, '/');
  return ENTITY_SHAPED_DIRS.some(d => norm.startsWith(d));
}

export function shouldFlipType({ relPath, currentType, hasAliases }) {
  if (!hasAliases) return false;
  if (!inEntityShapedDir(relPath)) return false;
  return currentType === 'topic';
}
