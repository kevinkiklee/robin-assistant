import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DECAY_DAYS, defaultDecayFor, isStale } from '../scripts/lib/decay.js';

// ---------------------------------------------------------------------------
// DECAY_DAYS constant
// ---------------------------------------------------------------------------
describe('DECAY_DAYS', () => {
  it('has expected values', () => {
    assert.equal(DECAY_DAYS.slow, 365);
    assert.equal(DECAY_DAYS.medium, 90);
    assert.equal(DECAY_DAYS.fast, 30);
    assert.equal(DECAY_DAYS.immortal, Infinity);
  });
});

// ---------------------------------------------------------------------------
// defaultDecayFor — sub-tree defaults
// ---------------------------------------------------------------------------
describe('defaultDecayFor — sub-tree defaults', () => {
  it('profile/ → slow', () => {
    assert.equal(defaultDecayFor('profile/identity.md'), 'slow');
    assert.equal(defaultDecayFor('profile/goals.md'), 'slow');
  });

  it('knowledge/ → medium', () => {
    assert.equal(defaultDecayFor('knowledge/movies/ratings.md'), 'medium');
    assert.equal(defaultDecayFor('knowledge/github/INDEX.md'), 'medium');
  });

  it('self-improvement/ → medium', () => {
    assert.equal(defaultDecayFor('self-improvement/corrections.md'), 'medium');
    assert.equal(defaultDecayFor('self-improvement/calibration.md'), 'medium');
  });

  it('sources/ → slow', () => {
    assert.equal(defaultDecayFor('sources/letterboxd.md'), 'slow');
  });

  it('unknown sub-tree → medium (fallback)', () => {
    assert.equal(defaultDecayFor('archive/old-notes.md'), 'medium');
  });
});

// ---------------------------------------------------------------------------
// defaultDecayFor — immortal file names (override sub-tree)
// ---------------------------------------------------------------------------
describe('defaultDecayFor — immortal file exclusions', () => {
  it('inbox.md → immortal regardless of sub-tree', () => {
    assert.equal(defaultDecayFor('inbox.md'), 'immortal');
    assert.equal(defaultDecayFor('profile/inbox.md'), 'immortal');
  });

  it('decisions.md → immortal', () => {
    assert.equal(defaultDecayFor('decisions.md'), 'immortal');
  });

  it('journal.md → immortal', () => {
    assert.equal(defaultDecayFor('journal.md'), 'immortal');
  });

  it('log.md → immortal', () => {
    assert.equal(defaultDecayFor('log.md'), 'immortal');
  });

  it('tasks.md → immortal', () => {
    assert.equal(defaultDecayFor('tasks.md'), 'immortal');
  });
});

// ---------------------------------------------------------------------------
// isStale — exact threshold boundaries
// ---------------------------------------------------------------------------
describe('isStale — threshold boundaries', () => {
  // Use a fixed "today" so tests don't drift.
  const now = new Date('2026-04-30T00:00:00.000Z');

  it('exactly at threshold is not stale (boundary inclusive)', () => {
    // 365 days before 2026-04-30 = 2025-04-30
    assert.equal(isStale('2025-04-30', 'slow', now), false);
  });

  it('one day past threshold is stale', () => {
    // 366 days before: 2025-04-29
    assert.equal(isStale('2025-04-29', 'slow', now), true);
  });

  it('medium — 90 days exactly is not stale', () => {
    // 90 days before 2026-04-30 = 2026-01-30 (but easier: use ms arithmetic)
    const d = new Date(now.getTime() - 90 * 86_400_000);
    const iso = d.toISOString().slice(0, 10);
    assert.equal(isStale(iso, 'medium', now), false);
  });

  it('medium — 91 days is stale', () => {
    const d = new Date(now.getTime() - 91 * 86_400_000);
    const iso = d.toISOString().slice(0, 10);
    assert.equal(isStale(iso, 'medium', now), true);
  });

  it('fast — 30 days exactly is not stale', () => {
    const d = new Date(now.getTime() - 30 * 86_400_000);
    const iso = d.toISOString().slice(0, 10);
    assert.equal(isStale(iso, 'fast', now), false);
  });

  it('fast — 31 days is stale', () => {
    const d = new Date(now.getTime() - 31 * 86_400_000);
    const iso = d.toISOString().slice(0, 10);
    assert.equal(isStale(iso, 'fast', now), true);
  });
});

// ---------------------------------------------------------------------------
// isStale — immortal never stale
// ---------------------------------------------------------------------------
describe('isStale — immortal', () => {
  const now = new Date('2026-04-30');

  it('immortal returns false even for ancient dates', () => {
    assert.equal(isStale('2000-01-01', 'immortal', now), false);
  });

  it('immortal returns false when date is missing', () => {
    assert.equal(isStale(null, 'immortal', now), false);
    assert.equal(isStale(undefined, 'immortal', now), false);
    assert.equal(isStale('', 'immortal', now), false);
  });
});

// ---------------------------------------------------------------------------
// isStale — missing / invalid dates
// ---------------------------------------------------------------------------
describe('isStale — missing or invalid lastVerified', () => {
  const now = new Date('2026-04-30');

  it('null → stale', () => assert.equal(isStale(null, 'slow', now), true));
  it('undefined → stale', () => assert.equal(isStale(undefined, 'slow', now), true));
  it('empty string → stale', () => assert.equal(isStale('', 'slow', now), true));
  it('garbage string → stale', () => assert.equal(isStale('not-a-date', 'slow', now), true));
});

// ---------------------------------------------------------------------------
// isStale — future dates
// ---------------------------------------------------------------------------
describe('isStale — future last_verified', () => {
  const now = new Date('2026-04-30');

  it('future date is not stale (ageDays < 0 → not > threshold)', () => {
    assert.equal(isStale('2026-12-31', 'fast', now), false);
  });
});
