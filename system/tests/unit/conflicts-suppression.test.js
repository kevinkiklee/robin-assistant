import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applySuppression } from '../../cognition/intuition/conflicts.js';

const now = new Date('2026-05-11T12:00:00Z');
const cfg = {
  conflict_min_confidence: 0.4,
  conflict_max_age_days: 30,
};

function pair({
  hitConf = 0.7,
  hitTs = '2026-05-09T12:00:00Z',
  hitFresh = 0.5,
  hitScope = 'global',
  otherConf = 0.7,
  otherTs = '2026-05-09T12:00:00Z',
  otherFresh = 0.5,
  otherScope = 'global',
} = {}) {
  return {
    hitSide: {
      id: 'memos:hit',
      confidence: hitConf,
      ts: hitTs,
      freshness: hitFresh,
      scope: hitScope,
      content: 'hit content',
    },
    otherSide: {
      id: 'memos:other',
      confidence: otherConf,
      ts: otherTs,
      freshness: otherFresh,
      scope: otherScope,
      content: 'other content',
    },
  };
}

test('rule 1: hitSide.confidence < min_confidence -> suppressed (low_confidence)', () => {
  const r = applySuppression(pair({ hitConf: 0.3 }), now, cfg);
  assert.equal(r.keep, false);
  assert.equal(r.reason, 'low_confidence');
});

test('rule 1: otherSide.confidence < min_confidence -> suppressed (low_confidence)', () => {
  const r = applySuppression(pair({ otherConf: 0.35 }), now, cfg);
  assert.equal(r.keep, false);
  assert.equal(r.reason, 'low_confidence');
});

test('rule 2: hitSide.freshness === 0 -> suppressed (superseded)', () => {
  const r = applySuppression(pair({ hitFresh: 0 }), now, cfg);
  assert.equal(r.keep, false);
  assert.equal(r.reason, 'superseded');
});

test('rule 2: otherSide.freshness === 0 -> suppressed (superseded)', () => {
  const r = applySuppression(pair({ otherFresh: 0 }), now, cfg);
  assert.equal(r.keep, false);
  assert.equal(r.reason, 'superseded');
});

test('rule 4: max(hitSide.ts, otherSide.ts) older than max_age_days -> stale', () => {
  const r = applySuppression(
    pair({ hitTs: '2026-04-09T00:00:00Z', otherTs: '2026-04-08T00:00:00Z' }),
    now,
    cfg,
  );
  assert.equal(r.keep, false);
  assert.equal(r.reason, 'stale');
});

test('rule 4: 29-day-old pair surfaces (no rule fires)', () => {
  const r = applySuppression(
    pair({ hitTs: '2026-04-12T12:00:00Z', otherTs: '2026-04-12T12:00:00Z' }),
    now,
    cfg,
  );
  assert.equal(r.keep, true);
});

test('rule precedence: low-confidence pair attributed to low_confidence, not stale', () => {
  // low conf + stale: low_confidence fires first per §5.2 ordering.
  const r = applySuppression(
    pair({ hitConf: 0.3, hitTs: '2026-04-08T00:00:00Z', otherTs: '2026-04-08T00:00:00Z' }),
    now,
    cfg,
  );
  assert.equal(r.keep, false);
  assert.equal(r.reason, 'low_confidence');
});

test('rule 3: both sides private -> suppressed (both_blocked)', () => {
  const r = applySuppression(pair({ hitScope: 'private', otherScope: 'private' }), now, cfg);
  assert.equal(r.keep, false);
  assert.equal(r.reason, 'both_blocked');
});

test('rule 3 redaction: hit private, other global -> keep with redactSide=hit', () => {
  const r = applySuppression(pair({ hitScope: 'private', otherScope: 'global' }), now, cfg);
  assert.equal(r.keep, true);
  assert.equal(r.redactSide, 'hit');
});

test('rule 3 redaction: hit global, other private -> keep with redactSide=other', () => {
  const r = applySuppression(pair({ hitScope: 'global', otherScope: 'private' }), now, cfg);
  assert.equal(r.keep, true);
  assert.equal(r.redactSide, 'other');
});

test('both global -> no redaction signal', () => {
  const r = applySuppression(pair({ hitScope: 'global', otherScope: 'global' }), now, cfg);
  assert.equal(r.keep, true);
  assert.equal(r.redactSide, undefined);
});

test('rule precedence: private + low-confidence -> low_confidence (not both_blocked)', () => {
  const r = applySuppression(
    pair({ hitScope: 'private', otherScope: 'private', hitConf: 0.3 }),
    now,
    cfg,
  );
  assert.equal(r.keep, false);
  assert.equal(r.reason, 'low_confidence');
});
