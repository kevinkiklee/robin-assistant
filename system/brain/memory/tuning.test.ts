// system/brain/memory/tuning.test.ts
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  DEFAULT_TUNING,
  getTuning,
  resetTuning,
  setTuning,
  tuningHash,
  validateTuningPatch,
} from './tuning.ts';

afterEach(() => resetTuning());

test('DEFAULT_TUNING equals the pre-refactor constants', () => {
  assert.deepEqual(DEFAULT_TUNING.promotionThreshold, {
    'first-party': 0.5,
    inferred: 0.85,
    'third-party': 0.9,
    external: Number.POSITIVE_INFINITY,
    unknown: 0.8,
  });
  assert.deepEqual(DEFAULT_TUNING.freshnessTtlDays, {
    'first-party': Number.POSITIVE_INFINITY,
    inferred: 180,
    'third-party': 120,
    external: 7,
    unknown: 365,
  });
  assert.equal(DEFAULT_TUNING.inferredHalfLifeDays, 180);
  assert.equal(DEFAULT_TUNING.decayFloor, 0.5);
  assert.equal(DEFAULT_TUNING.suspectConfidenceThreshold, 0.7);
  assert.equal(DEFAULT_TUNING.promoteAgeDays, 7);
  assert.equal(DEFAULT_TUNING.candidateExpiryDays, 14);
  assert.equal(DEFAULT_TUNING.conflictExpiryDays, 30);
  assert.equal(DEFAULT_TUNING.nearDupRatio, 0.2);
  assert.equal(DEFAULT_TUNING.reconcileBatch, 20);
  assert.equal(DEFAULT_TUNING.reconcileMaxPerRun, 40);
  assert.equal(DEFAULT_TUNING.expiredLookbackDays, 120);
});

test('setTuning merges scalars and partial records; resetTuning restores defaults', () => {
  setTuning({ promoteAgeDays: 3, promotionThreshold: { inferred: 0.75 } });
  assert.equal(getTuning().promoteAgeDays, 3);
  assert.equal(getTuning().promotionThreshold.inferred, 0.75);
  assert.equal(getTuning().promotionThreshold['first-party'], 0.5);
  resetTuning();
  assert.deepEqual(getTuning(), DEFAULT_TUNING);
});

test('setTuning rejects unknown keys and unknown record members', () => {
  assert.throws(
    () => setTuning({ promoteAgeDay: 3 } as never),
    /unknown tuning key: promoteAgeDay/,
  );
  assert.throws(
    () => setTuning({ promotionThreshold: { inferrred: 0.7 } } as never),
    /unknown tuning key: promotionThreshold.inferrred/,
  );
});

test('getTuning returns a frozen object', () => {
  assert.ok(Object.isFrozen(getTuning()));
  assert.ok(Object.isFrozen(getTuning().promotionThreshold));
});

test('setTuning: rejects inherited and prototype keys', () => {
  assert.throws(() => setTuning({ toString: 1 } as never), /unknown tuning key: toString/);
  assert.throws(
    () => setTuning({ promotionThreshold: { constructor: 0.5 } } as never),
    /unknown tuning key: promotionThreshold.constructor/,
  );
});

test('setTuning: rejects non-finite and out-of-range scalars', () => {
  assert.throws(() => setTuning({ reconcileBatch: 0 }), /invalid tuning value: reconcileBatch=0/);
  assert.throws(() => setTuning({ reconcileBatch: 2.5 }), /reconcileBatch=2.5/);
  assert.throws(() => setTuning({ reconcileMaxPerRun: -1 }), /reconcileMaxPerRun/);
  assert.throws(() => setTuning({ promoteAgeDays: Number.NaN }), /promoteAgeDays=NaN/);
  assert.throws(() => setTuning({ promoteAgeDays: Number.POSITIVE_INFINITY }), /promoteAgeDays/);
  assert.throws(() => setTuning({ decayFloor: 1.5 }), /decayFloor=1.5/);
  assert.throws(() => setTuning({ inferredHalfLifeDays: 0 }), /inferredHalfLifeDays=0/);
  assert.throws(() => setTuning({ nearDupRatio: '0.2' } as never), /nearDupRatio=0.2/);
});

test('setTuning: record members allow Infinity but not NaN or non-objects', () => {
  setTuning({ freshnessTtlDays: { inferred: Number.POSITIVE_INFINITY } });
  assert.equal(getTuning().freshnessTtlDays.inferred, Number.POSITIVE_INFINITY);
  resetTuning();
  assert.throws(() => setTuning({ promotionThreshold: { inferred: Number.NaN } }), /inferred=NaN/);
  assert.throws(() => setTuning({ promotionThreshold: { inferred: 1.2 } }), /inferred=1.2/);
  assert.throws(() => setTuning({ promotionThreshold: [0.5] } as never), /must be an object/);
});

test('setTuning: a rejected patch changes nothing (atomic)', () => {
  assert.throws(() => setTuning({ promoteAgeDays: 3, reconcileBatch: 0 }));
  assert.equal(getTuning().promoteAgeDays, DEFAULT_TUNING.promoteAgeDays);
});

test('validateTuningPatch: rejects a non-object patch', () => {
  assert.throws(() => validateTuningPatch(null), /plain object/);
  assert.throws(() => validateTuningPatch([]), /plain object/);
});

test('tuningHash: stable, distinguishes Infinity, changes with tuning', () => {
  const base = tuningHash();
  assert.match(base, /^[0-9a-f]{16}$/);
  assert.equal(tuningHash(), base);
  setTuning({ promoteAgeDays: 3 });
  assert.notEqual(tuningHash(), base);
  resetTuning();
  setTuning({ freshnessTtlDays: { inferred: Number.POSITIVE_INFINITY } });
  const inf = tuningHash();
  resetTuning();
  setTuning({ freshnessTtlDays: { inferred: 365 } });
  assert.notEqual(tuningHash(), inf);
});
