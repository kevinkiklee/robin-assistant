// system/lib/sky/recipes.test.ts

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { matchRecipes, mergeMatches } from './recipes.ts';
import type { ColorRead } from './types.ts';

const promising = (window: 'sunrise' | 'sunset'): ColorRead => ({
  window,
  band: 'promising',
  why: 'high cloud + clear horizon',
  caution: null,
  confidence: 0.8,
  azimuth: window === 'sunrise' ? 58 : 302,
  clouds: {
    high: 55,
    mid: 10,
    low: 15,
    horizonLowPct: 5,
    horizonGap: true,
    gapBearing: window === 'sunrise' ? 58 : 302,
  },
});

test('sunset colour fires inside the 1.5–3.5h lead window', () => {
  const m = matchRecipes({
    sunset: promising('sunset'),
    sunsetLeadH: 3,
    dates: { sunrise: '2026-06-26', sunset: '2026-06-25' },
  });
  assert.equal(m.length, 1);
  assert.equal(m[0].recipe, 'sunset_color');
  assert.equal(m[0].key, 'sunset:2026-06-25');
});

test('sunset colour suppressed when too soon (<1.5h)', () => {
  const m = matchRecipes({
    sunset: promising('sunset'),
    sunsetLeadH: 0.5,
    dates: { sunrise: '2026-06-26', sunset: '2026-06-25' },
  });
  assert.equal(m.length, 0);
});

const fogNight = (
  over: Partial<{ index: number; tafConcurs: boolean; preDawn: boolean }> = {},
) => ({
  index: 8,
  peakWindow: '3am–6am',
  tafConcurs: true,
  preDawn: true,
  ...over,
});

test('sunrise colour + fog night are separate notifications, not merged', () => {
  const m = matchRecipes({
    sunrise: promising('sunrise'),
    sunriseLeadH: 9,
    fog: fogNight(),
    dates: { sunrise: '2026-06-26', sunset: '2026-06-25' },
  });
  assert.equal(m.length, 2);
  const notes = mergeMatches(m);
  assert.equal(notes.length, 2);
  const fog = notes.find((n) => n.title.includes('Fog'));
  assert.ok(fog);
  assert.match(fog.message, /8\/10, peak 3am–6am · TAF concurs/);
  assert.equal(fog.silent, undefined);
});

test('fog night suppressed without TAF concurrence, whatever the index', () => {
  const m = matchRecipes({
    sunriseLeadH: 9,
    fog: fogNight({ index: 10, tafConcurs: false }),
    dates: { sunrise: '2026-06-26', sunset: '2026-06-25' },
  });
  assert.equal(m.length, 0);
});

test('fog night suppressed when the peak does not reach pre-dawn', () => {
  const m = matchRecipes({
    sunriseLeadH: 9,
    fog: fogNight({ preDawn: false }),
    dates: { sunrise: '2026-06-26', sunset: '2026-06-25' },
  });
  assert.equal(m.length, 0);
});

test('fog night suppressed below index 6', () => {
  const m = matchRecipes({
    sunriseLeadH: 9,
    fog: fogNight({ index: 5 }),
    dates: { sunrise: '2026-06-26', sunset: '2026-06-25' },
  });
  assert.equal(m.length, 0);
});

test('fog_on fires silently from a METAR inside the pre-dawn gate', () => {
  const m = matchRecipes({
    sunriseLeadH: 1.5,
    metar: { fogOn: true, mistForming: false, visibilityMi: 0.5, station: 'KJFK' },
    dates: { sunrise: '2026-06-26', sunset: '2026-06-25' },
  });
  assert.equal(m.length, 1);
  assert.equal(m[0].recipe, 'fog_on');
  assert.equal(m[0].key, 'fog-on:2026-06-26:fog');
  assert.match(m[0].title, /Fog is on/);
  assert.equal(m[0].body, 'KJFK vis ½ mi');
  const notes = mergeMatches(m);
  assert.equal(notes[0].silent, true);
});

test('fog_on mist stage has its own key and title', () => {
  const m = matchRecipes({
    sunriseLeadH: 1.5,
    metar: { fogOn: false, mistForming: true, visibilityMi: 2.5 },
    dates: { sunrise: '2026-06-26', sunset: '2026-06-25' },
  });
  assert.equal(m.length, 1);
  assert.equal(m[0].key, 'fog-on:2026-06-26:mist');
  assert.match(m[0].title, /Mist forming/);
  assert.equal(m[0].body, 'METAR vis 2½ mi', 'no station → generic label');
});

test('fog_on suppressed outside the pre-dawn gate and on a clear METAR', () => {
  const late = matchRecipes({
    sunriseLeadH: 9,
    metar: { fogOn: true, mistForming: false, visibilityMi: 0.25 },
    dates: { sunrise: '2026-06-26', sunset: '2026-06-25' },
  });
  assert.equal(late.length, 0);
  const clear = matchRecipes({
    sunriseLeadH: 1.5,
    metar: { fogOn: false, mistForming: false, visibilityMi: 10 },
    dates: { sunrise: '2026-06-26', sunset: '2026-06-25' },
  });
  assert.equal(clear.length, 0);
});

test('rain_clearing fires inside the 1.5–3.5h sunset lead window', () => {
  const m = matchRecipes({
    rainClearing: true,
    sunsetLeadH: 3,
    dates: { sunrise: '2026-06-26', sunset: '2026-06-25' },
  });
  assert.equal(m.length, 1);
  assert.equal(m[0].recipe, 'rain_clearing');
  assert.equal(m[0].window, 'sunset');
});

test('rain_clearing suppressed when too soon (<1.5h)', () => {
  const m = matchRecipes({
    rainClearing: true,
    sunsetLeadH: 0.5,
    dates: { sunrise: '2026-06-26', sunset: '2026-06-25' },
  });
  assert.equal(m.length, 0);
});

// ── moon ─────────────────────────────────────────────────────────────────────

const moonBase = () => ({
  illumination: 0.95,
  event: 'rise' as const,
  eventTime: new Date('2026-06-26T05:30:00'),
  azimuth: 85,
  horizonClear: true,
  phaseName: 'full',
  leadH: 9,
  window: 'sunrise' as const,
});

test('moon fires at illumination=0.95, horizonClear=true, in-lead', () => {
  const m = matchRecipes({
    moon: moonBase(),
    dates: { sunrise: '2026-06-26', sunset: '2026-06-25' },
  });
  assert.equal(m.length, 1);
  assert.equal(m[0].recipe, 'moon');
  assert.equal(m[0].window, 'sunrise');
  assert.equal(m[0].key, 'moon:2026-06-26');
  assert.match(m[0].title, /Full moon rises/);
  assert.match(m[0].title, /az 85°/);
  assert.match(m[0].title, /clear horizon/);
});

test('moon suppressed at illumination=0.85 (below threshold)', () => {
  const m = matchRecipes({
    moon: { ...moonBase(), illumination: 0.85 },
    dates: { sunrise: '2026-06-26', sunset: '2026-06-25' },
  });
  assert.equal(m.length, 0);
});

test('moon suppressed when horizonClear=false', () => {
  const m = matchRecipes({
    moon: { ...moonBase(), horizonClear: false },
    dates: { sunrise: '2026-06-26', sunset: '2026-06-25' },
  });
  assert.equal(m.length, 0);
});

test('moon suppressed when out-of-lead (leadH=3, sunrise window needs 6–14h)', () => {
  const m = matchRecipes({
    moon: { ...moonBase(), leadH: 3 },
    dates: { sunrise: '2026-06-26', sunset: '2026-06-25' },
  });
  assert.equal(m.length, 0);
});

// ── tide_window ───────────────────────────────────────────────────────────────

const tideBase = () => ({
  low: { time: new Date('2026-06-26T06:00:00'), heightFt: 0.3 },
  leadH: 9,
});

test('tide_window fires when low tide present + in-lead', () => {
  const m = matchRecipes({
    tide: tideBase(),
    dates: { sunrise: '2026-06-26', sunset: '2026-06-25' },
  });
  assert.equal(m.length, 1);
  assert.equal(m[0].recipe, 'tide_window');
  assert.equal(m[0].window, 'sunrise');
  assert.equal(m[0].key, 'tide:2026-06-26');
  assert.match(m[0].title, /exposed flats/);
});

test('tide_window suppressed when out-of-lead (leadH=3, sunrise window needs 6–14h)', () => {
  const m = matchRecipes({
    tide: { ...tideBase(), leadH: 3 },
    dates: { sunrise: '2026-06-26', sunset: '2026-06-25' },
  });
  assert.equal(m.length, 0);
});

// ── moon set + sunrise window shares mergeGroup with other sunrise alerts ─────

test('moon set+sunrise window bundles with sunrise_color via mergeMatches', () => {
  const m = matchRecipes({
    sunrise: promising('sunrise'),
    sunriseLeadH: 9,
    moon: { ...moonBase(), event: 'set', window: 'sunrise' },
    dates: { sunrise: '2026-06-26', sunset: '2026-06-25' },
  });
  // Both sunrise_color and moon should fire
  assert.ok(m.some((r) => r.recipe === 'sunrise_color'));
  assert.ok(m.some((r) => r.recipe === 'moon'));
  // Both share the same mergeGroup
  const sunriseGroup = m.filter((r) => r.mergeGroup === 'sunrise:2026-06-26');
  assert.equal(sunriseGroup.length, 2);
  // mergeMatches collapses them into one notification
  const notes = mergeMatches(m);
  assert.equal(notes.length, 1);
});

test('sunset colour suppressed when too far out (>3.5h) — the fresher tick fires instead', () => {
  const m = matchRecipes({
    sunset: promising('sunset'),
    sunsetLeadH: 4.9,
    dates: { sunrise: '2026-06-26', sunset: '2026-06-25' },
  });
  assert.equal(m.length, 0);
});

test('mixed band never fires, whatever the confidence', () => {
  const m = matchRecipes({
    sunset: { ...promising('sunset'), band: 'mixed', confidence: 0.95 },
    sunsetLeadH: 3,
    dates: { sunrise: '2026-06-26', sunset: '2026-06-25' },
  });
  assert.equal(m.length, 0);
});

test('promising below the confidence floor is suppressed', () => {
  const m = matchRecipes({
    sunset: { ...promising('sunset'), confidence: 0.5 },
    sunsetLeadH: 3,
    dates: { sunrise: '2026-06-26', sunset: '2026-06-25' },
  });
  assert.equal(m.length, 0);
});
