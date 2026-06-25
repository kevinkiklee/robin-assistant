import { test } from 'node:test';
import assert from 'node:assert/strict';
import { colorRead, bearingLabel } from './color.ts';
import type { SkyContext } from './types.ts';

const base: SkyContext = {
  window: 'sunset', azimuth: 302, horizonGap: true, gapBearing: 302,
  canvas: { high: 55, mid: 10 }, verdict: 'promising', confidence: 0.7, samples: [],
};

test('bearingLabel maps degrees to compass point', () => {
  assert.equal(bearingLabel(302), 'WNW');
  assert.equal(bearingLabel(58), 'ENE');
});

test('promising ⇒ band promising, why mentions high cloud + horizon', () => {
  const r = colorRead(base);
  assert.equal(r.band, 'promising');
  assert.match(r.why, /high cloud/i);
  assert.match(r.why, /WNW/);
});

test('blocked ⇒ band unlikely, terse, caution null', () => {
  const r = colorRead({ ...base, verdict: 'blocked', horizonGap: false, gapBearing: null });
  assert.equal(r.band, 'unlikely');
  assert.equal(r.caution, null);
});

test('promising + horizonGap + confidence ≥ 0.5 ⇒ caution null', () => {
  const r = colorRead({ ...base, verdict: 'promising', horizonGap: true, confidence: 0.7 });
  assert.equal(r.band, 'promising');
  assert.equal(r.caution, null);
});
