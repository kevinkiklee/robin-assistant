export const EXCLUDED_PATHS = [
  'inbox.md',
  'journal.md',
  'log.md',
  'decisions.md',
  'tasks.md',
  'hot.md',
  'LINKS.md',
  'INDEX.md',
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
