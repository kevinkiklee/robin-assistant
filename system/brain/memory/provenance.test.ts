import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ageDaysFrom,
  classifyProvenance,
  confidenceDecay,
  effectiveConfidence,
  FRESHNESS_TTL_DAYS,
  isStale,
  PROMOTION_THRESHOLD,
  type ProvenanceClass,
  SUSPECT_CONFIDENCE_THRESHOLD,
  WEAK_PROVENANCE,
} from './provenance.ts';

test('classifyProvenance: integration sources → external', () => {
  assert.equal(classifyProvenance(['integration.gmail.message']), 'external');
  assert.equal(classifyProvenance(['integration.whoop.recovery']), 'external');
});

test('classifyProvenance: Kevin-authored session → first-party', () => {
  assert.equal(classifyProvenance(['session.captured']), 'first-party');
  assert.equal(classifyProvenance(['capture.session']), 'first-party');
});

test('classifyProvenance: reasoning/dream-derived → inferred', () => {
  assert.equal(classifyProvenance(['dream.synthesis']), 'inferred');
  assert.equal(classifyProvenance(['biographer.extracted']), 'inferred');
});

test('classifyProvenance: empty or unrecognized → unknown', () => {
  assert.equal(classifyProvenance([]), 'unknown');
  assert.equal(classifyProvenance(['something.weird']), 'unknown');
});

test('classifyProvenance: first-party wins when Kevin also stated it', () => {
  // A claim Kevin asserted that an integration also touched stays first-party —
  // his own assertion is the strongest signal and is not weakened by corroboration.
  assert.equal(
    classifyProvenance(['integration.gmail.message', 'session.captured']),
    'first-party',
  );
});

test('classifyProvenance: weakest known class wins among non-first-party', () => {
  assert.equal(classifyProvenance(['dream.synthesis', 'integration.gmail.message']), 'external');
});

test('WEAK_PROVENANCE flags inferred/third-party/external, not first-party/unknown', () => {
  assert.ok(WEAK_PROVENANCE.has('inferred'));
  assert.ok(WEAK_PROVENANCE.has('third-party'));
  assert.ok(WEAK_PROVENANCE.has('external'));
  assert.ok(!WEAK_PROVENANCE.has('first-party'));
  assert.ok(!WEAK_PROVENANCE.has('unknown'));
});

test('PROMOTION_THRESHOLD: external never promotes (Infinity), first-party lenient', () => {
  assert.equal(PROMOTION_THRESHOLD.external, Number.POSITIVE_INFINITY);
  assert.ok(PROMOTION_THRESHOLD['first-party'] < PROMOTION_THRESHOLD.inferred);
  assert.ok(PROMOTION_THRESHOLD.inferred <= PROMOTION_THRESHOLD['third-party']);
});

test('isStale: first-party never stale; external stale after a week', () => {
  assert.equal(isStale(9999, 'first-party'), false);
  assert.equal(isStale(8, 'external'), true);
  assert.equal(isStale(3, 'external'), false);
  assert.equal(FRESHNESS_TTL_DAYS['first-party'], Number.POSITIVE_INFINITY);
});

test('confidenceDecay: only inferred decays, floored at 0.5', () => {
  assert.equal(confidenceDecay(1000, 'first-party'), 1);
  assert.equal(confidenceDecay(0, 'inferred'), 1);
  const decayed = confidenceDecay(180, 'inferred');
  assert.ok(decayed < 1 && decayed >= 0.5);
  assert.equal(confidenceDecay(100000, 'inferred'), 0.5); // floor
});

test('effectiveConfidence: null passes through; inferred shaded by age', () => {
  assert.equal(effectiveConfidence(null, 10, 'inferred'), null);
  assert.equal(effectiveConfidence(0.8, 0, 'first-party'), 0.8);
  const eff = effectiveConfidence(0.8, 180, 'inferred');
  assert.ok(eff !== null && eff < 0.8);
});

test('ageDaysFrom: computes day delta; invalid → 0', () => {
  const now = Date.parse('2026-05-25T00:00:00Z');
  assert.equal(Math.round(ageDaysFrom('2026-05-15T00:00:00Z', now)), 10);
  assert.equal(ageDaysFrom('not-a-date', now), 0);
  assert.equal(ageDaysFrom('2099-01-01T00:00:00Z', now), 0); // future floored to 0
});

test('SUSPECT_CONFIDENCE_THRESHOLD is a sane 0..1 gate', () => {
  assert.ok(SUSPECT_CONFIDENCE_THRESHOLD > 0 && SUSPECT_CONFIDENCE_THRESHOLD < 1);
});

test('every ProvenanceClass has a threshold and a TTL', () => {
  const classes: ProvenanceClass[] = [
    'first-party',
    'inferred',
    'third-party',
    'external',
    'unknown',
  ];
  for (const c of classes) {
    assert.ok(c in PROMOTION_THRESHOLD, `${c} missing threshold`);
    assert.ok(c in FRESHNESS_TTL_DAYS, `${c} missing TTL`);
  }
});
