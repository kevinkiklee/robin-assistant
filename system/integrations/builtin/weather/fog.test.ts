import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyTafGate,
  type FogNight,
  fogNights,
  localHourToUtcMs,
  type OmHourly,
  parseMetarFogSignal,
  parseTafFogSignal,
  wmoText,
} from './fog.ts';

// Build a 2-day hourly series; saturate the night of 2026-06-25.
function series(): OmHourly {
  const time: string[] = [];
  const at = (d: string, h: number) => `${d}T${String(h).padStart(2, '0')}:00`;
  for (const d of ['2026-06-25', '2026-06-26']) for (let h = 0; h < 24; h++) time.push(at(d, h));
  const n = time.length;
  const fill = (v: number) => Array(n).fill(v);
  const h: OmHourly = {
    time,
    temperature_2m: fill(60),
    dew_point_2m: fill(59),
    relative_humidity_2m: fill(96),
    wind_speed_10m: fill(3),
    weather_code: fill(2),
    visibility: fill(20000),
  };
  return h;
}

test('fogNights: saturated calm night ⇒ high index, likely band', () => {
  const nights = fogNights(series(), '2026-06-25');
  const tonight = nights.find((x) => x.date === '2026-06-25');
  assert.ok(tonight);
  // spread=1°F / RH=96 / wind=3 → composite ≈9.3, rounds to index 9
  assert.ok((tonight as { index: number }).index >= 8, `index ${tonight?.index}`);
});

test('fogNights: dry windy clear night ⇒ unlikely band', () => {
  // Build a series identical to series() but with dry/windy/clear conditions.
  const time: string[] = [];
  const at = (d: string, h: number) => `${d}T${String(h).padStart(2, '0')}:00`;
  for (const d of ['2026-06-25', '2026-06-26']) for (let h = 0; h < 24; h++) time.push(at(d, h));
  const n = time.length;
  const fill = (v: number) => Array(n).fill(v);
  const dryHourly: OmHourly = {
    time,
    temperature_2m: fill(70),
    dew_point_2m: fill(40),
    relative_humidity_2m: fill(40),
    wind_speed_10m: fill(20),
    weather_code: fill(2),
    visibility: fill(20000),
  };
  const nights = fogNights(dryHourly, '2026-06-25');
  const tonight = nights.find((x) => x.date === '2026-06-25');
  assert.ok(tonight, 'night entry should exist');
  assert.equal(tonight!.band, 'unlikely', `band was ${tonight!.band}`);
});

test('fogNights: night with <2 scorable slots is skipped', () => {
  // Only provide T21:00 of 2026-06-25; none of 2026-06-26's 00/03/06 slots.
  const time = ['2026-06-25T21:00'];
  const fill = (v: number) => Array(1).fill(v);
  const sparse: OmHourly = {
    time,
    temperature_2m: fill(60),
    dew_point_2m: fill(59),
    relative_humidity_2m: fill(96),
    wind_speed_10m: fill(3),
    weather_code: fill(2),
    visibility: fill(20000),
  };
  const nights = fogNights(sparse, '2026-06-25');
  const tonight = nights.find((x) => x.date === '2026-06-25');
  assert.equal(tonight, undefined, 'sparse night should be skipped');
});

test('wmoText maps codes', () => {
  assert.equal(wmoText(0), 'clear');
  assert.equal(wmoText(45), 'fog');
  assert.equal(wmoText(3), 'overcast');
});

// ── cloud gate ─────────────────────────────────────────────────────────────────
//
// Radiation fog needs a sky the ground can radiate through. A saturated, calm
// night under a solid deck (an overcast night that scored "likely" and produced
// no fog) must not reach "likely" on the composite alone. Provider signals
// (WMO 45/48, low visibility) stay ungated — advection/marine fog forms under
// cloud and the provider is reporting observation-grade fog, not potential.

function withClouds(h: OmHourly, low: number, mid: number, high: number): OmHourly {
  const n = h.time.length;
  const fill = (v: number) => Array(n).fill(v);
  return {
    ...h,
    cloud_cover_low: fill(low),
    cloud_cover_mid: fill(mid),
    cloud_cover_high: fill(high),
  };
}

test('fogNights: saturated night under a solid deck is capped to unlikely', () => {
  const nights = fogNights(withClouds(series(), 10, 90, 100), '2026-06-25');
  const tonight = nights.find((x) => x.date === '2026-06-25');
  assert.ok(tonight, 'night entry should exist');
  assert.ok(tonight!.index <= 2, `index ${tonight!.index} should be overcast-capped`);
  assert.equal(tonight!.band, 'unlikely', `band was ${tonight!.band}`);
});

test('fogNights: saturated night under a clear sky keeps its high score', () => {
  const nights = fogNights(withClouds(series(), 0, 0, 0), '2026-06-25');
  const tonight = nights.find((x) => x.date === '2026-06-25');
  assert.ok(tonight!.index >= 8, `index ${tonight!.index}`);
});

test('fogNights: high-cloud-only (cirrus) night is not gated', () => {
  // Thin high cloud lets most longwave cooling through: 0.3 × 100 = 30% ≤ the
  // 40% blockage threshold → composite untouched.
  const nights = fogNights(withClouds(series(), 0, 0, 100), '2026-06-25');
  const tonight = nights.find((x) => x.date === '2026-06-25');
  assert.ok(tonight!.index >= 8, `index ${tonight!.index}`);
});

test('fogNights: provider fog signal (WMO 45) is not cloud-gated', () => {
  const h = withClouds(series(), 100, 100, 100);
  const overcastFog: OmHourly = { ...h, weather_code: h.time.map(() => 45) };
  const nights = fogNights(overcastFog, '2026-06-25');
  const tonight = nights.find((x) => x.date === '2026-06-25');
  assert.equal(tonight!.index, 10);
  assert.equal(tonight!.band, 'very likely');
});

test('fogNights: rain-driven low visibility is not scored as fog', () => {
  // A station can fall to 1SM in +TSRA — a downpour, not fog, and the
  // model's visibility field collapses the same way in heavy precipitation. The
  // provider branch reads visibility directly, so without a precipitation check
  // every thunderstorm night scores as fog potential.
  const h = withClouds(series(), 100, 100, 100);
  const stormy: OmHourly = {
    ...h,
    temperature_2m: h.time.map(() => 68),
    dew_point_2m: h.time.map(() => 60),
    relative_humidity_2m: h.time.map(() => 76),
    wind_speed_10m: h.time.map(() => 12),
    weather_code: h.time.map(() => 95), // thunderstorm
    visibility: h.time.map(() => 1500),
  };
  const nights = fogNights(stormy, '2026-06-25');
  const tonight = nights.find((x) => x.date === '2026-06-25');
  assert.ok(tonight, 'night entry should exist');
  assert.equal(tonight!.index, 0, `index ${tonight!.index} — precip visibility must not score`);
  assert.equal(tonight!.band, 'unlikely', `band was ${tonight!.band}`);
});

// ─── TAF cross-check gate ──────────────────────────────────────────────────────

// A synthetic TAF for a model-wet night: the composite says 9/10 "very likely"
// while the station holds P6SM all night. The only BR in this TAF is an
// afternoon rain-shower TEMPO (19–21Z) that does NOT touch the night window.
const MISS_NIGHT_TAF = `TAF KQRS 141725Z 1418/1524 24008KT P6SM FEW030 SCT120
  TEMPO 1419/1421 27014G22KT 5SM -SHRA BR OVC025
  FM142300 31006KT P6SM SCT045
  FM150400 33004KT P6SM BKN060
  FM150800 VRB03KT P6SM SCT080 SCT200
  FM151600 18007KT P6SM FEW050 BKN200
  FM151900 19010KT P6SM SCT055 BKN220`;

const REF = new Date('2027-05-14T18:00:00Z');
const NY = 'America/New_York';

test('localHourToUtcMs: resolves EDT and EST local hours', () => {
  assert.equal(localHourToUtcMs('2027-05-14', 21, NY), Date.parse('2027-05-15T01:00:00Z'));
  assert.equal(localHourToUtcMs('2027-01-21', 21, NY), Date.parse('2027-01-22T02:00:00Z'));
});

test('parseTafFogSignal: validity parsed; the rain-mist TEMPO is not a fog group', () => {
  const sig = parseTafFogSignal(MISS_NIGHT_TAF, REF);
  assert.ok(sig);
  assert.equal(sig?.validFrom, Date.parse('2027-05-14T18:00:00Z'));
  assert.equal(sig?.validTo, Date.parse('2027-05-16T00:00:00Z')); // 1524 = day 15 hour 24
  // The TEMPO's BR rides with -SHRA: mist in rain is precipitation-reduced
  // visibility, not a fog forecast, so it is NOT a fog group.
  assert.equal(sig?.fogRanges.length, 0, 'the -SHRA BR TEMPO is rain-mist, not fog');
});

test('applyTafGate: a model-wet night is capped to possible (regression)', () => {
  const night: FogNight = {
    date: '2027-05-14',
    index: 9,
    band: 'very likely',
    peak_window: '12am–6am',
    factors: 'spread 1°F · RH 93% · wind 3 mph',
  };
  const [gated] = applyTafGate([night], parseTafFogSignal(MISS_NIGHT_TAF, REF), NY);
  assert.equal(gated.index, 4);
  assert.equal(gated.band, 'possible');
  assert.match(gated.factors ?? '', /TAF: no fog groups — capped from 9/);
  assert.equal(gated.peak_window, '12am–6am', 'peak window is preserved for the curious');
});

test('applyTafGate: an overnight FG/BR group corroborates instead of capping', () => {
  const withFog = MISS_NIGHT_TAF.replace('FM150800 VRB03KT P6SM', 'FM150800 VRB02KT 1/2SM FG');
  const night: FogNight = {
    date: '2027-05-14',
    index: 8,
    band: 'likely',
    peak_window: '3am–6am',
    factors: 'spread 3°F · RH 95% · wind 1 mph',
  };
  const [gated] = applyTafGate([night], parseTafFogSignal(withFog, REF), NY);
  assert.equal(gated.index, 8, 'corroborated index survives');
  assert.match(gated.factors ?? '', /TAF concurs/);
});

test('applyTafGate: a PROB30 fog group overlapping the night also corroborates', () => {
  const prob = `${MISS_NIGHT_TAF}\n  PROB30 1506/1509 2SM BR OVC003`;
  const night: FogNight = {
    date: '2027-05-14',
    index: 7,
    band: 'likely',
    peak_window: '3am–6am',
    factors: null,
  };
  const [gated] = applyTafGate([night], parseTafFogSignal(prob, REF), NY);
  assert.equal(gated.index, 7);
  assert.match(gated.factors ?? '', /TAF concurs/);
});

test('parseTafFogSignal: BR without precipitation is still a fog group', () => {
  // Guard the other side of the rule: genuine mist is a real fog precursor.
  const misty = MISS_NIGHT_TAF.replace('5SM -SHRA BR OVC025', '5SM BR OVC025');
  const sig = parseTafFogSignal(misty, REF);
  assert.equal(sig?.fogRanges.length, 1, 'bare BR remains fog-positive');
});

test('applyTafGate: an overnight rain-mist group does not corroborate', () => {
  // +TSRA BR at 04Z (12am ET) sits inside the night window. Mist inside a
  // thunderstorm says nothing about radiation fog, so the wet-biased composite
  // must still be capped rather than confirmed.
  const stormy = MISS_NIGHT_TAF.replace(
    'FM150400 33004KT P6SM BKN060',
    'FM150400 33004KT 2SM +TSRA BR BKN012',
  );
  const night: FogNight = {
    date: '2027-05-14',
    index: 9,
    band: 'very likely',
    peak_window: '12am–6am',
    factors: 'spread 2°F · RH 98% · wind 4 mph',
  };
  const [gated] = applyTafGate([night], parseTafFogSignal(stormy, REF), NY);
  assert.equal(gated.index, 4, 'rain-mist must not corroborate a model fog night');
  assert.match(gated.factors ?? '', /capped from 9/);
});

test('applyTafGate: no TAF → a high band is marked model-only, never capped', () => {
  const night: FogNight = {
    date: '2027-05-14',
    index: 9,
    band: 'very likely',
    peak_window: '12am–6am',
    factors: 'spread 1°F · RH 93% · wind 3 mph',
  };
  const [gated] = applyTafGate([night], null, NY);
  assert.equal(gated.index, 9, 'no evidence, no cap');
  assert.match(gated.factors ?? '', /model-only/);
});

test('applyTafGate: a TAF that does not cover the whole night counts as unavailable', () => {
  // Validity ends 15/06Z = 2am ET — the 21:00→06:00 local window is not covered.
  const short = MISS_NIGHT_TAF.replace('1418/1524', '1418/1506');
  const night: FogNight = {
    date: '2027-05-14',
    index: 8,
    band: 'likely',
    peak_window: '3am–6am',
    factors: null,
  };
  const [gated] = applyTafGate([night], parseTafFogSignal(short, REF), NY);
  assert.equal(gated.index, 8);
  assert.match(gated.factors ?? '', /model-only/);
});

test('applyTafGate: a low index passes through a clean TAF untouched', () => {
  const night: FogNight = {
    date: '2027-05-14',
    index: 3,
    band: 'possible',
    peak_window: '3am',
    factors: 'spread 5°F · RH 88% · wind 6 mph',
  };
  const [gated] = applyTafGate([night], parseTafFogSignal(MISS_NIGHT_TAF, REF), NY);
  assert.equal(gated.index, 3);
  assert.equal(gated.factors, 'spread 5°F · RH 88% · wind 6 mph', 'no annotation noise');
});

test('parseMetarFogSignal: FG token with fractional vis is fog on', () => {
  const m = parseMetarFogSignal('KJFK 210851Z 00000KT 1/4SM FG VV002 14/14 A3012 RMK AO2 SLP199');
  assert.ok(m);
  assert.equal(m.visibilityMi, 0.25);
  assert.equal(m.fogOn, true);
  assert.equal(m.mistForming, false);
  assert.equal(m.obsTime, '0851Z');
});

test('parseMetarFogSignal: BR at 2 1/2SM is mist forming; compound vis parsed', () => {
  const m = parseMetarFogSignal('KJFK 210951Z 03003KT 2 1/2SM BR CLR 15/14 A3013');
  assert.ok(m);
  assert.equal(m.visibilityMi, 2.5);
  assert.equal(m.fogOn, false);
  assert.equal(m.mistForming, true);
});

test('parseMetarFogSignal: mist inside rain is not fog', () => {
  const m = parseMetarFogSignal('KJFK 210951Z 03003KT 2SM -RA BR OVC005 15/14 A3013');
  assert.ok(m);
  assert.equal(m.fogOn, false);
  assert.equal(m.mistForming, false);
});

test('parseMetarFogSignal: clear 10SM is neither; sub-1mi vis alone counts as fog', () => {
  const clear = parseMetarFogSignal('KJFK 210951Z 03003KT 10SM CLR 15/14 A3013');
  assert.ok(clear);
  assert.equal(clear.visibilityMi, 10);
  assert.equal(clear.fogOn, false);
  assert.equal(clear.mistForming, false);
  const dense = parseMetarFogSignal('KJFK 210951Z 00000KT M1/4SM VV001 14/14 A3012');
  assert.ok(dense);
  assert.equal(dense.fogOn, true);
});

test('parseMetarFogSignal: garbage → null, and RMK section is ignored', () => {
  assert.equal(parseMetarFogSignal(''), null);
  assert.equal(parseMetarFogSignal('No METAR data'), null);
  const m = parseMetarFogSignal('KJFK 210951Z 03003KT 10SM CLR 15/14 A3013 RMK AO2 FG DSIPTD');
  assert.ok(m);
  assert.equal(m.fogOn, false);
});
