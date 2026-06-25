import { test } from 'node:test';
import assert from 'node:assert/strict';
import { destPoint, samplePoints } from './geo.ts';

test('destPoint: 111 km due north ≈ +1° latitude', () => {
  const p = destPoint(40, -74, 0, 111.195);
  assert.ok(Math.abs(p.lat - 41) < 0.05, `lat ${p.lat}`);
  assert.ok(Math.abs(p.lng - -74) < 0.05, `lng ${p.lng}`);
});

test('samplePoints: 5 distances, fan at the far two (90,120) ⇒ 9 points', () => {
  const pts = samplePoints({ lat: 40.764, lng: -73.923 }, 302);
  assert.equal(pts.length, 9); // 5 on-bearing + 2×2 fan
  assert.ok(pts.some((p) => p.distKm === 0));
  const farBearings = pts.filter((p) => p.distKm === 120).map((p) => Math.round(p.bearing));
  assert.deepEqual(farBearings.sort((a, b) => a - b), [290, 302, 314]); // 302 ± 12
});
