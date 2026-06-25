import { test } from 'node:test';
import assert from 'node:assert/strict';
import { skyContext } from './directional.ts';
import type { SamplePoint } from './types.ts';

const near = (high: number, mid: number, low: number): SamplePoint =>
  ({ distKm: 0, bearing: 302, lat: 0, lng: 0, layers: { low, mid, high } });
const far = (low: number): SamplePoint =>
  ({ distKm: 120, bearing: 302, lat: 0, lng: 0, layers: { low, mid: 0, high: 0 } });

test('promising: 100% high cloud overhead + clear far horizon gap', () => {
  const ctx = skyContext({ window: 'sunset', azimuth: 302, leadHours: 2,
    samples: [near(100, 0, 0), far(5), far(10)] });
  assert.equal(ctx.verdict, 'promising');
  assert.equal(ctx.horizonGap, true);
});

test('blocked: clear overhead but a low-cloud bank at the horizon', () => {
  const ctx = skyContext({ window: 'sunset', azimuth: 302, leadHours: 2,
    samples: [near(0, 0, 0), far(85), far(90)] });
  assert.equal(ctx.verdict, 'blocked');
  assert.equal(ctx.horizonGap, false);
});

test('clear: gap but empty canvas ⇒ light, no colour', () => {
  const ctx = skyContext({ window: 'sunset', azimuth: 302, leadHours: 2,
    samples: [near(0, 0, 0), far(5)] });
  assert.equal(ctx.verdict, 'clear');
});

test('confidence drops with lead time', () => {
  const a = skyContext({ window: 'sunrise', azimuth: 58, leadHours: 2, samples: [near(50, 0, 0), far(5)] });
  const b = skyContext({ window: 'sunrise', azimuth: 58, leadHours: 16, samples: [near(50, 0, 0), far(5)] });
  assert.ok(a.confidence > b.confidence);
});

test('confidence is strictly lower at coverage 0.3 than coverage 1', () => {
  const samples = [near(100, 0, 0), far(5), far(10)];
  const full = skyContext({ window: 'sunset', azimuth: 302, leadHours: 2, samples, coverage: 1 });
  const sparse = skyContext({ window: 'sunset', azimuth: 302, leadHours: 2, samples, coverage: 0.3 });
  assert.ok(sparse.confidence < full.confidence,
    `expected sparse.confidence (${sparse.confidence}) < full.confidence (${full.confidence})`);
});
