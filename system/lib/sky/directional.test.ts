import assert from 'node:assert/strict';
import { test } from 'node:test';
import { skyContext } from './directional.ts';
import type { SamplePoint } from './types.ts';

const near = (high: number, mid: number, low: number): SamplePoint => ({
  distKm: 0,
  bearing: 302,
  lat: 0,
  lng: 0,
  layers: { low, mid, high },
});
const far = (low: number, mid = 0, bearing = 302): SamplePoint => ({
  distKm: 120,
  bearing,
  lat: 0,
  lng: 0,
  layers: { low, mid, high: 0 },
});

test('promising: broken high cloud overhead + clear on-axis far horizon', () => {
  const ctx = skyContext({
    window: 'sunset',
    azimuth: 302,
    leadHours: 2,
    samples: [near(55, 10, 0), far(5), far(10)],
  });
  assert.equal(ctx.verdict, 'promising');
  assert.equal(ctx.horizonGap, true);
});

test('not promising: 100% high cloud overhead is an overcast lid, not a canvas', () => {
  const ctx = skyContext({
    window: 'sunset',
    azimuth: 302,
    leadHours: 2,
    samples: [near(100, 0, 0), far(5), far(10)],
  });
  assert.equal(ctx.verdict, 'mixed');
  assert.equal(ctx.horizonGap, true);
});

test('not promising: mid-cloud overcast overhead vetoes even inside the canvas band', () => {
  // 0 high + 90 mid → canvasStrength 63 (in band) but mid > canvasMidMaxPct.
  const ctx = skyContext({
    window: 'sunset',
    azimuth: 302,
    leadHours: 2,
    samples: [near(0, 90, 0), far(5)],
  });
  assert.equal(ctx.verdict, 'mixed');
});

test('not promising: low cloud overhead hides the canvas', () => {
  const ctx = skyContext({
    window: 'sunset',
    azimuth: 302,
    leadHours: 2,
    samples: [near(55, 10, 60), far(5)],
  });
  assert.equal(ctx.verdict, 'mixed');
});

test('not promising: one clear fan-edge sample is not a gap when the axis is cloudy', () => {
  // Old rule took min() over the fan, so far(5) at the edge counted as a gap.
  const ctx = skyContext({
    window: 'sunset',
    azimuth: 302,
    leadHours: 2,
    samples: [near(55, 10, 0), far(40), far(45, 0, 314), far(5, 0, 290)],
  });
  assert.equal(ctx.verdict, 'mixed');
  assert.equal(ctx.horizonGap, false);
});

test('not promising: thick mid deck at the horizon blocks the low sun', () => {
  const ctx = skyContext({
    window: 'sunset',
    azimuth: 302,
    leadHours: 2,
    samples: [near(55, 10, 0), far(5, 80)],
  });
  assert.equal(ctx.verdict, 'mixed');
  assert.equal(ctx.horizonGap, false);
});

test('gap needs the fan mean clear too, not just the axis', () => {
  const ctx = skyContext({
    window: 'sunset',
    azimuth: 302,
    leadHours: 2,
    samples: [near(55, 10, 0), far(5), far(70, 0, 314), far(70, 0, 290)],
  });
  assert.equal(ctx.horizonGap, false);
});

test('blocked: clear overhead but a low-cloud bank at the horizon', () => {
  const ctx = skyContext({
    window: 'sunset',
    azimuth: 302,
    leadHours: 2,
    samples: [near(0, 0, 0), far(85), far(90)],
  });
  assert.equal(ctx.verdict, 'blocked');
  assert.equal(ctx.horizonGap, false);
});

test('clear: gap but empty canvas ⇒ light, no colour', () => {
  const ctx = skyContext({
    window: 'sunset',
    azimuth: 302,
    leadHours: 2,
    samples: [near(0, 0, 0), far(5)],
  });
  assert.equal(ctx.verdict, 'clear');
});

test('confidence drops with lead time', () => {
  const a = skyContext({
    window: 'sunrise',
    azimuth: 58,
    leadHours: 2,
    samples: [near(50, 0, 0), far(5)],
  });
  const b = skyContext({
    window: 'sunrise',
    azimuth: 58,
    leadHours: 16,
    samples: [near(50, 0, 0), far(5)],
  });
  assert.ok(a.confidence > b.confidence);
});

test('confidence is strictly lower at coverage 0.3 than coverage 1', () => {
  const samples = [near(100, 0, 0), far(5), far(10)];
  const full = skyContext({ window: 'sunset', azimuth: 302, leadHours: 2, samples, coverage: 1 });
  const sparse = skyContext({
    window: 'sunset',
    azimuth: 302,
    leadHours: 2,
    samples,
    coverage: 0.3,
  });
  assert.ok(
    sparse.confidence < full.confidence,
    `expected sparse.confidence (${sparse.confidence}) < full.confidence (${full.confidence})`,
  );
});

test('confidence is strictly lower when ensemble agreement is low', () => {
  const samples = [near(100, 0, 0), far(5), far(10)];
  const agree = skyContext({ window: 'sunset', azimuth: 302, leadHours: 2, samples, agreement: 1 });
  const disagree = skyContext({
    window: 'sunset',
    azimuth: 302,
    leadHours: 2,
    samples,
    agreement: 0.4,
  });
  assert.ok(
    disagree.confidence < agree.confidence,
    `expected disagree.confidence (${disagree.confidence}) < agree.confidence (${agree.confidence})`,
  );
  // Default (omitted) agreement must behave as 1 (no penalty).
  const dflt = skyContext({ window: 'sunset', azimuth: 302, leadHours: 2, samples });
  assert.equal(dflt.confidence, agree.confidence, 'omitted agreement defaults to 1');
});
