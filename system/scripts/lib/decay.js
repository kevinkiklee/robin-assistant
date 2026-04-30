// Decay-rate helpers for memory-quality heuristics (D1).
//
// decay classes: slow | medium | fast | immortal
// DECAY_DAYS maps each class to a number of days (Infinity = never stale).
//
// defaultDecayFor(relPath) — given a path relative to user-data/memory/,
// returns the default decay class for that sub-tree.
//
// isStale(lastVerifiedISO, decay, now) — returns true when the file should be
// reviewed. Missing/invalid date is treated as stale.

/** @type {{ slow: number, medium: number, fast: number, immortal: number }} */
export const DECAY_DAYS = {
  slow: 365,
  medium: 90,
  fast: 30,
  immortal: Infinity,
};

// Files that are append-only and never go stale regardless of sub-tree.
const IMMORTAL_FILES = new Set([
  'inbox.md',
  'decisions.md',
  'journal.md',
  'log.md',
  'tasks.md',
]);

/**
 * Return the default decay class for a path relative to user-data/memory/.
 * Caller may override via frontmatter `decay:` field — this is only the
 * sub-tree default.
 *
 * @param {string} relPath  e.g. "profile/identity.md" or "knowledge/movies/ratings.md"
 * @returns {'slow'|'medium'|'fast'|'immortal'}
 */
export function defaultDecayFor(relPath) {
  // Normalise slashes.
  const p = relPath.replace(/\\/g, '/');

  // Filename-level immortals — check first so sub-tree doesn't override.
  const basename = p.split('/').at(-1) ?? '';
  if (IMMORTAL_FILES.has(basename)) return 'immortal';

  // Sub-tree defaults.
  if (p.startsWith('profile/')) return 'slow';
  if (p.startsWith('knowledge/')) return 'medium';
  if (p.startsWith('self-improvement/')) return 'medium';
  if (p.startsWith('sources/')) return 'slow';

  // Fallback: treat unknown sub-trees as medium.
  return 'medium';
}

/**
 * Return true if the file should be reviewed (is past its decay threshold).
 *
 * @param {string|null|undefined} lastVerifiedISO  YYYY-MM-DD or falsy
 * @param {'slow'|'medium'|'fast'|'immortal'} decay
 * @param {Date} [now]  defaults to today
 * @returns {boolean}
 */
export function isStale(lastVerifiedISO, decay, now = new Date()) {
  if (decay === 'immortal') return false;

  if (!lastVerifiedISO || typeof lastVerifiedISO !== 'string') return true;

  const parsed = Date.parse(lastVerifiedISO);
  if (Number.isNaN(parsed)) return true;

  const ageMs = now.getTime() - parsed;
  const ageDays = ageMs / 86_400_000;
  const threshold = DECAY_DAYS[decay] ?? DECAY_DAYS.medium;
  return ageDays > threshold;
}
