import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { agreementFactor, SPREAD_FULL } from './ensemble.ts';

test('ensemble agreement factor', async (t) => {
  await t.test('empty array returns 1 (no disagreement)', () => {
    assert.equal(agreementFactor([]), 1);
  });

  await t.test('single element returns 1 (no disagreement)', () => {
    assert.equal(agreementFactor([50]), 1);
  });

  await t.test('identical members returns 1 (perfect agreement)', () => {
    assert.equal(agreementFactor([40, 40, 40, 40]), 1);
  });

  await t.test('tightly clustered members returns high agreement (>0.9)', () => {
    const agreement = agreementFactor([40, 42, 38, 41]);
    assert.ok(agreement > 0.9, `Expected >0.9, got ${agreement}`);
  });

  await t.test('wildly split members returns ~0 (clamped)', () => {
    const agreement = agreementFactor([0, 100, 0, 100]);
    assert.ok(agreement < 0.05, `Expected <0.05, got ${agreement}`);
  });

  await t.test('moderate spread (stdev ≈ 17.5) returns agreement ≈ 0.5', () => {
    // [25, 25, 75, 75] has mean 50, stdev ≈ 25
    // Let's use a moderately spread set: [25, 35, 65, 75] mean 50
    // stdev ≈ sqrt(((25-50)² + (35-50)² + (65-50)² + (75-50)²) / 4)
    //       = sqrt((625 + 225 + 225 + 625) / 4) = sqrt(1700/4) = sqrt(425) ≈ 20.6
    // agreement = 1 - 20.6/35 ≈ 1 - 0.59 ≈ 0.41
    // Let's use [35, 45, 55, 65] mean 50
    // stdev = sqrt(((35-50)² + (45-50)² + (55-50)² + (65-50)²) / 4)
    //       = sqrt((225 + 25 + 25 + 225) / 4) = sqrt(500/4) = sqrt(125) ≈ 11.2
    // agreement = 1 - 11.2/35 ≈ 1 - 0.32 ≈ 0.68
    // Let's aim for stdev ≈ 17.5: need bigger spread
    // [25, 40, 60, 75] mean 50
    // stdev = sqrt(((25-50)² + (40-50)² + (60-50)² + (75-50)²) / 4)
    //       = sqrt((625 + 100 + 100 + 625) / 4) = sqrt(1350/4) ≈ sqrt(337.5) ≈ 18.37
    // agreement = 1 - 18.37/35 ≈ 1 - 0.525 ≈ 0.475 ≈ 0.5 ✓
    const agreement = agreementFactor([25, 40, 60, 75]);
    assert.ok(agreement > 0.45 && agreement < 0.55, `Expected 0.45-0.55, got ${agreement}`);
  });

  await t.test('SPREAD_FULL constant is exported and tunable', () => {
    assert.ok(typeof SPREAD_FULL === 'number');
    assert.equal(SPREAD_FULL, 35);
  });

  await t.test('two identical members returns 1', () => {
    assert.equal(agreementFactor([50, 50]), 1);
  });

  await t.test('two members with max spread returns 0', () => {
    const agreement = agreementFactor([0, 100]);
    assert.equal(agreement, 0);
  });

  await t.test('boundary: stdev exactly SPREAD_FULL returns ~0', () => {
    // We need a distribution with stdev = 35
    // For a 4-member sample: mean 50, need sum of squared deviations = 35² * 4 = 4900
    // [0, 50, 50, 100] has deviations [-50, 0, 0, 50], sum sq = 2500 + 0 + 0 + 2500 = 5000
    // stdev = sqrt(5000/4) = sqrt(1250) ≈ 35.36 ✓
    const agreement = agreementFactor([0, 50, 50, 100]);
    assert.ok(agreement >= -0.05 && agreement <= 0.05, `Expected ~0, got ${agreement}`);
  });
});
