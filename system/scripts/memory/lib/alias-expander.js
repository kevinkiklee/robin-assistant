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
