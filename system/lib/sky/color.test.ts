import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bearingLabel, colorRead } from './color.ts';
import type { SkyContext } from './types.ts';

// Near-field sample (distKm=25, below nearFieldKm=50)
const nearSample = {
  distKm: 25,
  bearing: 302,
  lat: 40.9,
  lng: -74.2,
  layers: { high: 55, mid: 10, low: 20 },
};
// Far-field sample (distKm=90, at farFieldKm boundary → horizon zone)
const farSample = {
  distKm: 90,
  bearing: 302,
  lat: 41.4,
  lng: -74.8,
  layers: { high: 10, mid: 5, low: 5 },
};

const base: SkyContext = {
  window: 'sunset',
  azimuth: 302,
  horizonGap: true,
  gapBearing: 302,
  canvas: { high: 55, mid: 10 },
  verdict: 'promising',
  confidence: 0.7,
  samples: [nearSample, farSample],
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

test('clouds overhead computed from near-field samples', () => {
  const r = colorRead(base);
  // near-field: canvas.high=55, canvas.mid=10, low from nearSample.layers.low=20
  assert.equal(r.clouds.high, 55);
  assert.equal(r.clouds.mid, 10);
  assert.equal(r.clouds.low, 20);
  // far-field: min low from farSample.layers.low=5
  assert.equal(r.clouds.horizonLowPct, 5);
  assert.equal(r.clouds.horizonGap, true);
  assert.equal(r.clouds.gapBearing, 302);
});

test('blocked ⇒ band unlikely, terse, caution null', () => {
  const r = colorRead({ ...base, verdict: 'blocked', horizonGap: false, gapBearing: null });
  assert.equal(r.band, 'unlikely');
  assert.equal(r.caution, null);
  // horizonGap propagates into clouds
  assert.equal(r.clouds.horizonGap, false);
  assert.equal(r.clouds.gapBearing, null);
});

test('promising + horizonGap + confidence ≥ 0.5 ⇒ caution null', () => {
  const r = colorRead({ ...base, verdict: 'promising', horizonGap: true, confidence: 0.7 });
  assert.equal(r.band, 'promising');
  assert.equal(r.caution, null);
});

test('clouds with no samples ⇒ low=0, horizonLowPct=null', () => {
  const ctx: SkyContext = { ...base, samples: [] };
  const r = colorRead(ctx);
  assert.equal(r.clouds.low, 0);
  assert.equal(r.clouds.horizonLowPct, null);
});
