export const EXCLUDED_PATHS = [
  'inbox.md',
  'journal.md',
  'log.md',
  'decisions.md',
  'tasks.md',
  'hot.md',
  'LINKS.md',
  'INDEX.md',
  // Post-0021 streams/ subdir:
  'streams/inbox.md',
  'streams/journal.md',
  'streams/log.md',
  'streams/decisions.md',
];

export const EXCLUDED_PREFIXES = [
  'archive/',
  'quarantine/',
  'self-improvement/',
];

export function isExcludedPath(relPath) {
  if (EXCLUDED_PATHS.includes(relPath)) return true;
  return EXCLUDED_PREFIXES.some(p => relPath.startsWith(p));
}

const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---/;
const FENCED_CODE_RE = /^(```|~~~)[^\n]*\r?\n[\s\S]*?\r?\n\1/gm;
const INLINE_CODE_RE = /`[^`\n]+`/g;
const MARKDOWN_LINK_RE = /\[[^\]]*\]\([^)]*\)/g;
const BARE_URL_RE = /https?:\/\/[^\s)]+/g;

export function computeSkipRanges(body) {
  const ranges = [];
  const fm = body.match(FRONTMATTER_RE);
  if (fm && fm.index === 0) ranges.push([0, fm[0].length]);

  for (const re of [FENCED_CODE_RE, INLINE_CODE_RE, MARKDOWN_LINK_RE, BARE_URL_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(body)) !== null) {
      ranges.push([m.index, m.index + m[0].length]);
    }
  }
  return ranges;
}

export function isInsideSkipRange(offset, ranges) {
  for (const [s, e] of ranges) {
    if (offset >= s && offset < e) return true;
  }
  return false;
}
