// system/lib/sky/recipes.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchRecipes, mergeMatches } from './recipes.ts';
import type { ColorRead } from './types.ts';

const promising = (window: 'sunrise' | 'sunset'): ColorRead =>
  ({ window, band: 'promising', why: 'high cloud + clear horizon', caution: null, confidence: 0.8, azimuth: window === 'sunrise' ? 58 : 302 });

test('sunset colour fires inside the 1.5–5h lead window', () => {
  const m = matchRecipes({ sunset: promising('sunset'), sunsetLeadH: 3, dates: { sunrise: '2026-06-26', sunset: '2026-06-25' } });
  assert.equal(m.length, 1);
  assert.equal(m[0].recipe, 'sunset_color');
  assert.equal(m[0].key, 'sunset:2026-06-25');
});

test('sunset colour suppressed when too soon (<1.5h)', () => {
  const m = matchRecipes({ sunset: promising('sunset'), sunsetLeadH: 0.5, dates: { sunrise: '2026-06-26', sunset: '2026-06-25' } });
  assert.equal(m.length, 0);
});

test('sunrise colour + fog merge into one notification', () => {
  const m = matchRecipes({
    sunrise: promising('sunrise'), sunriseLeadH: 9, fogIndex: 7, fogCoversSunrise: true,
    dates: { sunrise: '2026-06-26', sunset: '2026-06-25' },
  });
  assert.equal(m.length, 2);
  const notes = mergeMatches(m);
  assert.equal(notes.length, 1);
  assert.match(notes[0].message, /·/); // bodies joined
});
