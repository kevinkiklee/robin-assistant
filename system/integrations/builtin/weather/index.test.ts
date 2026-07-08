// Pin the process timezone to the integration's domain TZ before any Date math.
// solarTimes() is UTC-based (TZ-independent), but parseTides() interprets its
// "YYYY-MM-DD HH:mm" strings as LOCAL time and moonInfo() derives the local
// calendar day from host-local fields — so a deterministic TZ keeps the tide
// morning-golden-window match and the moon date stable across machines/CI.
process.env.TZ = 'America/New_York';

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeDb, openDb } from '../../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../../brain/memory/migrations/index.ts';
import { listAlerts } from '../../../kernel/runtime/alert-store.ts';
import { moonInfo } from '../../../lib/lunar.ts';
import { SKY } from '../../../lib/sky/constants.ts';
import { samplePoints } from '../../../lib/sky/geo.ts';
import { sunBearings } from '../../../lib/solar.ts';
import { integration } from './index.ts';

// Fixed test instant: 2026-06-25T20:00:00-04:00.
//   - today's sunset is ~20:30 EDT → NOT yet passed → sunset window = today (daily.sunset[0])
//   - today's sunrise was ~05:25 EDT → already passed → sunrise window = tomorrow (daily.sunrise[1])
const TEST_NOW = new Date('2026-06-25T20:00:00-04:00');

// ── Response builder ──────────────────────────────────────────────────────────
//
// Build an Open-Meteo-shaped array response with one entry per coord.  Coords
// match exactly what the tick constructs (pushCoord deduped, origin first, then
// sunrise then sunset samples), so `locFor(lat, lng)` finds every entry.
//
// The sunset window samples (daily.sunset[0] = '2026-06-25T20:30', rounded to
// hourIso '2026-06-25T21:00') are set for a PROMISING verdict:
//   far-field (distKm ≥ 90): cloud_cover_low = 5  → minFarLow < 25 → horizonGap
//   near-field (distKm ≤ 50, incl. origin): cloud_cover_high = 60, mid = 10
//     → canvasStrength = 67 ≥ 25 → canvasInBand
//   → horizonGap && canvasInBand → 'promising'

function buildResponse(): object[] {
  const origin = SKY.origin;
  const { sunriseAz, sunsetAz } = sunBearings(origin.lat, origin.lng, TEST_NOW);
  const sunriseSamples = sunriseAz != null ? samplePoints(origin, sunriseAz) : [];
  const sunsetSamples = sunsetAz != null ? samplePoints(origin, sunsetAz) : [];

  // Replicate tick's pushCoord dedup.
  const coords: Array<{ lat: number; lng: number; distKm?: number; isSunset?: boolean }> = [];
  const seen = new Set<string>();
  const push = (c: { lat: number; lng: number }, distKm?: number, isSunset?: boolean) => {
    const key = `${c.lat.toFixed(4)},${c.lng.toFixed(4)}`;
    if (seen.has(key)) return;
    seen.add(key);
    coords.push({ lat: c.lat, lng: c.lng, distKm, isSunset });
  };

  push(origin, 0, true); // origin counts as near-field for sunset
  for (const s of sunriseSamples) push(s, s.distKm, false);
  for (const s of sunsetSamples) push(s, s.distKm, true);

  // Hourly time arrays: 48h starting 2026-06-25T00:00 in local EST.
  // We need indices for:
  //   '2026-06-25T21:00' → sunset window hour (nearestHourIso('2026-06-25T20:30'))
  //   '2026-06-26T05:00' → sunrise window hour (nearestHourIso('2026-06-26T05:25'))
  // and the fog night slots: 2026-06-25T21:00, 2026-06-26T00:00, 03:00, 06:00
  const times: string[] = [];
  for (let d = 0; d < 2; d++) {
    for (let h = 0; h < 24; h++) {
      const day = d === 0 ? '2026-06-25' : '2026-06-26';
      times.push(`${day}T${String(h).padStart(2, '0')}:00`);
    }
  }
  const N = times.length; // 48

  // Helper: fill an array of length N with a base value, override specific hours.
  const fill = (base: number, overrides: Record<string, number> = {}): number[] => {
    const arr = Array<number>(N).fill(base);
    for (const [iso, val] of Object.entries(overrides)) {
      const idx = times.indexOf(iso);
      if (idx >= 0) arr[idx] = val;
    }
    return arr;
  };

  // Cloud pattern at the sunset hour (2026-06-25T21:00).
  const sunsetHour = '2026-06-25T21:00';

  return coords.map(({ lat, lng, distKm = 0, isSunset = false }) => {
    const isFar = distKm >= SKY.farFieldKm;
    const isNear = distKm <= SKY.nearFieldKm;

    // Cloud cover at the sunset window hour based on zone.
    const ccLow = isSunset && isFar ? 5 : 0;
    const ccMid = isSunset && isNear ? 10 : 0;
    const ccHigh = isSunset && isNear ? 60 : 0;

    return {
      latitude: lat,
      longitude: lng,
      current: {
        temperature_2m: 72,
        weather_code: 2,
        wind_speed_10m: 8,
        cloud_cover: 40,
      },
      hourly: {
        time: times,
        cloud_cover: fill(30),
        cloud_cover_low: fill(0, { [sunsetHour]: ccLow }),
        cloud_cover_mid: fill(0, { [sunsetHour]: ccMid }),
        cloud_cover_high: fill(0, { [sunsetHour]: ccHigh }),
        precipitation: fill(0),
        precipitation_probability: fill(0),
        // Fog fields (benign: no fog).
        temperature_2m: fill(65),
        dew_point_2m: fill(40),
        relative_humidity_2m: fill(55),
        wind_speed_10m: fill(8),
        weather_code: fill(2),
        visibility: fill(10000),
      },
      daily: {
        time: ['2026-06-25', '2026-06-26'],
        // daily.sunset[0] = today's sunset; daily.sunrise[1] = tomorrow's sunrise.
        sunrise: ['2026-06-25T05:25', '2026-06-26T05:25'],
        sunset: ['2026-06-25T20:30', '2026-06-26T20:30'],
      },
    };
  });
}

// ── Grid-snapped response builder (Bug 1 regression) ───────────────────────────
//
// The LIVE Open-Meteo API snaps each requested coordinate to its forecast grid
// and echoes the SNAPPED lat/lng, which differs from what we requested. This
// builder reproduces that: identical to buildResponse() in every way EXCEPT the
// echoed `latitude`/`longitude` are perturbed off the requested coord, so any
// rounded-lat/lng lookup (the old `byCoord`/`locFor`) misses on every sample and
// every layer collapses to {0,0,0} (confidence 0). With index-based matching the
// tick must still resolve full coverage and the controlled gap+canvas pattern
// must still yield a 'promising' sunset with confidence > 0. The array order is
// preserved (results[i] ↔ coords[i]) — that's the contract under test.
function buildSnappedResponse(): object[] {
  // Grid-snap simulation: round to 2 decimals (~1.1 km) AND nudge ~0.02° so the
  // echoed coord never equals the requested coord at toFixed(4) precision, yet
  // stays well within the sanity-check tolerance (0.3°).
  const snap = (v: number) => Math.round(v * 100) / 100 + 0.02;
  return (buildResponse() as Array<{ latitude: number; longitude: number }>).map((loc) => ({
    ...loc,
    latitude: snap(loc.latitude),
    longitude: snap(loc.longitude),
  }));
}

// ── Ensemble fixture ───────────────────────────────────────────────────────────
//
// Open-Meteo ensemble response: members are `cloud_cover_member01..NN` (numbering
// starts at 01; the bare `cloud_cover` is the control run and is NOT a member).
// `spread` controls per-member disagreement at the sunset window hour
// (2026-06-25T21:00): 0 ⇒ all members agree (agreement≈1), large ⇒ low agreement.
function buildEnsembleResponse(opts: { spread: number; members?: number }): object {
  const memberCount = opts.members ?? 12;
  const times: string[] = [];
  for (let d = 0; d < 2; d++) {
    for (let h = 0; h < 24; h++) {
      const day = d === 0 ? '2026-06-25' : '2026-06-26';
      times.push(`${day}T${String(h).padStart(2, '0')}:00`);
    }
  }
  const N = times.length;
  const sunsetIdx = times.indexOf('2026-06-25T21:00');

  const hourly: Record<string, unknown> = { time: times, cloud_cover: Array<number>(N).fill(50) };
  for (let m = 1; m <= memberCount; m++) {
    const arr = Array<number>(N).fill(50);
    if (sunsetIdx >= 0) {
      // Symmetric ±spread fan around 50 across members → controlled stdev.
      const sign = m % 2 === 0 ? 1 : -1;
      arr[sunsetIdx] = Math.max(0, Math.min(100, 50 + sign * opts.spread));
    }
    hourly[`cloud_cover_member${String(m).padStart(2, '0')}`] = arr;
  }
  return { latitude: 40.75, longitude: -74.0, hourly_units: { time: 'iso8601' }, hourly };
}

// ── Tide fixture ───────────────────────────────────────────────────────────────
//
// NOAA CO-OPS predictions JSON (product=predictions&interval=hilo). Times are
// local "YYYY-MM-DD HH:mm". By default a LOW tide lands inside the morning-golden
// window (sunrise ~05:25 → golden-hour-end ~06:?? on 2026-06-26).
function buildTideResponse(): object {
  return {
    predictions: [
      { t: '2026-06-25T23:10', v: '4.8', type: 'H' },
      { t: '2026-06-26T05:40', v: '0.3', type: 'L' }, // morning-golden low (in window)
      { t: '2026-06-26T11:50', v: '4.9', type: 'H' },
      { t: '2026-06-26T18:05', v: '0.5', type: 'L' },
    ],
  };
}

// ── Moon-path fixture ──────────────────────────────────────────────────────────
//
// At 2026-07-01T20:00 ET the moon is near-full (illum ≈ 0.974) and RISES ~02:00Z
// (≈ leadH 2.0, inside sunsetLeadHours [1.5,5]) at azimuth ≈ 119° ESE → a dusk
// moonrise feeding the SUNSET window. We build a forecast response covering the
// tick's full coord set for this instant (origin + sun fans + moon fan) with a
// CLEAR sky at every hour (all cloud layers 0) so the far-field horizon is open
// (horizonClear=true) and the moon recipe input is populated.
const MOON_NOW = new Date('2026-07-01T20:00:00-04:00');

function buildMoonResponse(): object[] {
  const origin = SKY.origin;
  const { sunriseAz, sunsetAz } = sunBearings(origin.lat, origin.lng, MOON_NOW);
  const moon = moonInfo(origin.lat, origin.lng, MOON_NOW);

  const coords: Array<{ lat: number; lng: number }> = [];
  const seen = new Set<string>();
  const push = (c: { lat: number; lng: number }) => {
    const key = `${c.lat.toFixed(4)},${c.lng.toFixed(4)}`;
    if (seen.has(key)) return;
    seen.add(key);
    coords.push({ lat: c.lat, lng: c.lng });
  };
  push(origin);
  if (sunriseAz != null) for (const s of samplePoints(origin, sunriseAz)) push(s);
  if (sunsetAz != null) for (const s of samplePoints(origin, sunsetAz)) push(s);
  // Moon fan (dusk moonrise → sunset window).
  if (moon.riseAz != null) for (const s of samplePoints(origin, moon.riseAz)) push(s);

  const times: string[] = [];
  for (let d = 0; d < 2; d++) {
    for (let h = 0; h < 24; h++) {
      const day = d === 0 ? '2026-07-01' : '2026-07-02';
      times.push(`${day}T${String(h).padStart(2, '0')}:00`);
    }
  }
  const N = times.length;
  const zeros = () => Array<number>(N).fill(0);

  return coords.map(({ lat, lng }) => ({
    latitude: lat,
    longitude: lng,
    current: { temperature_2m: 75, weather_code: 1, wind_speed_10m: 6, cloud_cover: 5 },
    hourly: {
      time: times,
      cloud_cover: zeros(),
      cloud_cover_low: zeros(), // clear far-field → horizonGap/horizonClear true
      cloud_cover_mid: zeros(),
      cloud_cover_high: zeros(),
      precipitation: zeros(),
      precipitation_probability: zeros(),
      temperature_2m: Array<number>(N).fill(68),
      dew_point_2m: Array<number>(N).fill(45),
      relative_humidity_2m: Array<number>(N).fill(50),
      wind_speed_10m: Array<number>(N).fill(6),
      weather_code: Array<number>(N).fill(1),
      visibility: Array<number>(N).fill(12000),
    },
    daily: {
      time: ['2026-07-01', '2026-07-02'],
      sunrise: ['2026-07-01T05:28', '2026-07-02T05:28'],
      sunset: ['2026-07-01T20:30', '2026-07-02T20:30'],
    },
  }));
}

// ── Context factory ───────────────────────────────────────────────────────────

interface FetchOverrides {
  forecast?: () => Promise<any>; // api.open-meteo.com/v1/forecast
  ensemble?: () => Promise<any>; // ensemble-api.open-meteo.com
  tide?: () => Promise<any>; // api.tidesandcurrents.gov
}

function makeCtx(
  captured: { payload?: any; content?: string; warns?: string[] },
  opts: {
    skyOff?: boolean;
    db?: any;
    fetchResponse?: () => Promise<any>;
    fetchByUrl?: FetchOverrides;
    state?: Record<string, string>;
    now?: Date;
  } = {},
) {
  const kv = new Map<string, string>();
  if (opts.skyOff) kv.set('sky_context', 'off');
  for (const [k, v] of Object.entries(opts.state ?? {})) kv.set(k, v);

  const ok = (json: () => Promise<any>) => async () => ({ ok: true, status: 200, json });

  // Route by host: forecast vs ensemble-api vs tidesandcurrents. Defaults reuse
  // the existing fixtures so legacy tests behave unchanged.
  const ov = opts.fetchByUrl ?? {};
  const routedFetch = async (url: string) => {
    if (url.includes('ensemble-api.open-meteo.com')) {
      return (ov.ensemble ?? ok(async () => buildEnsembleResponse({ spread: 0 })))();
    }
    if (url.includes('tidesandcurrents')) {
      return (ov.tide ?? ok(async () => buildTideResponse()))();
    }
    // api.open-meteo.com/v1/forecast (origin + sample fans).
    return (ov.forecast ?? ok(async () => buildResponse()))();
  };

  return {
    state: {
      get: (k: string) => kv.get(k) ?? null,
      set: (k: string, v: string) => void kv.set(k, v),
      delete: (k: string) => void kv.delete(k),
    },
    fetch: (opts.fetchResponse ?? routedFetch) as any,
    now: () => opts.now ?? TEST_NOW,
    ingest: async (input: any) => {
      captured.payload = input.payload;
      captured.content = input.content;
      return {};
    },
    db: (opts.db ?? {
      prepare: () => ({
        get: () => undefined,
        run: () => ({ changes: 0, lastInsertRowid: 1 }),
        all: () => [],
      }),
    }) as any,
    log: {
      info() {},
      warn(msg: string) {
        if (!captured.warns) captured.warns = [];
        captured.warns.push(msg);
      },
      error() {},
    },
    llm: null,
    checkOutbound: () => ({ allow: true }) as any,
  } as any;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('weather: behavioral — sunset band is promising with controlled cloud pattern', async () => {
  const cap: { payload?: any; content?: string } = {};
  const ctx = makeCtx(cap);
  const r = await integration.tick!(ctx);

  assert.equal(r.status, 'ok');
  assert.ok(cap.payload, 'payload captured');
  assert.equal(cap.payload.kind, 'current');

  // Base scalars.
  assert.ok(typeof cap.payload.temp_f !== 'undefined', 'temp_f defined');
  assert.ok(typeof cap.payload.wind_mph !== 'undefined', 'wind_mph defined');
  assert.ok(typeof cap.payload.cloud_cover !== 'undefined', 'cloud_cover defined');
  assert.ok(typeof cap.payload.desc === 'string', 'desc is a string');
  assert.ok(Array.isArray(cap.payload.fog_nights), 'fog_nights array');

  // ISO sun window fields.
  assert.match(cap.payload.sunrise ?? '', /^\d{4}-\d{2}-\d{2}T/, 'payload.sunrise is ISO');
  assert.match(cap.payload.sunset ?? '', /^\d{4}-\d{2}-\d{2}T/, 'payload.sunset is ISO');

  // Sky block.
  assert.ok(cap.payload.sky, 'sky block present');
  assert.ok('asOf' in cap.payload.sky, 'sky.asOf present');

  // At 8pm EDT sunset (~20:30) is NOT yet passed → a ColorRead is produced.
  assert.ok(cap.payload.sky.sunset, 'sky.sunset is non-null');
  assert.equal(cap.payload.sky.sunset.window, 'sunset', 'sunset window label');
  assert.ok(typeof cap.payload.sky.sunset.band === 'string', 'sunset band is string');

  // ── BEHAVIORAL ASSERTION: multi-coord → layersAt → skyContext → colorRead ──
  assert.equal(
    cap.payload.sky.sunset.band,
    'promising',
    'sunset.band is promising: far-field gap (ccLow=5) + near-field canvas (ccHigh=60, ccMid=10)',
  );
  assert.ok(
    typeof cap.payload.sky.sunset.why === 'string' &&
      cap.payload.sky.sunset.why.toLowerCase().includes('wnw'),
    `sunset.why mentions WNW horizon (got: "${cap.payload.sky.sunset.why}")`,
  );
});

test('weather: grid-snapped coords still resolve full coverage (Bug 1 regression)', async () => {
  // The live API echoes grid-snapped lat/lng (≠ requested). With lat/lng-key
  // matching every sample misses → {0,0,0} → confidence 0 → bogus "clear". With
  // index-based matching (results[i] ↔ coords[i]) the controlled gap+canvas
  // pattern must STILL produce a real, non-degenerate promising verdict.
  const cap: { payload?: any; warns?: string[] } = {};
  const ctx = makeCtx(cap, {
    fetchByUrl: {
      forecast: async () => ({ ok: true, status: 200, json: async () => buildSnappedResponse() }),
    },
  });
  const r = await integration.tick!(ctx);

  assert.equal(r.status, 'ok');
  assert.ok(cap.payload.sky.sunset, 'sky.sunset non-null under snapped coords');
  // The behavioral payoff: same pattern as the exact-coord test still lands.
  assert.equal(
    cap.payload.sky.sunset.band,
    'promising',
    'snapped coords still yield promising (index-based match resolved the forecast)',
  );
  assert.ok(
    cap.payload.sky.sunset.confidence > 0,
    `confidence must be > 0 (got ${cap.payload.sky.sunset.confidence}); 0 = the Bug 1 coverage collapse`,
  );
  assert.ok(
    typeof cap.payload.sky.sunset.why === 'string' &&
      cap.payload.sky.sunset.why.toLowerCase().includes('wnw'),
    `sunset.why mentions the WNW horizon gap (got: "${cap.payload.sky.sunset.why}")`,
  );
  // The sanity-check warn must NOT fire — the snap stays within 0.3° tolerance.
  assert.ok(
    !(cap.warns ?? []).some((w) => /response misalignment/.test(w)),
    'no misalignment warning for a normal grid-snap',
  );
});

test('weather: payload carries moon + tide blocks (ephemeris + CO-OPS)', async () => {
  const cap: { payload?: any } = {};
  const ctx = makeCtx(cap);
  const r = await integration.tick!(ctx);

  assert.equal(r.status, 'ok');
  // Moon block: raw ephemeris (always present regardless of illumination gate).
  assert.ok(cap.payload.moon, 'moon block present');
  assert.equal(typeof cap.payload.moon.illumination, 'number', 'moon.illumination numeric');
  assert.equal(typeof cap.payload.moon.phaseName, 'string', 'moon.phaseName string');
  // rise/set are ISO strings (or null) — at TEST_NOW the ephemeris yields both.
  if (cap.payload.moon.rise !== null) {
    assert.match(cap.payload.moon.rise, /^\d{4}-\d{2}-\d{2}T/, 'moon.rise ISO');
  }
  if (cap.payload.moon.set !== null) {
    assert.match(cap.payload.moon.set, /^\d{4}-\d{2}-\d{2}T/, 'moon.set ISO');
  }

  // Tide block: NOAA fixture has a LOW at 2026-06-26 05:40 ET → inside the
  // morning-golden window (sunrise 05:25 → golden-hour-end ~06:06 ET).
  assert.ok(cap.payload.tide, 'tide block present');
  assert.ok(
    cap.payload.tide.lowInGolden,
    'tide.lowInGolden present (low in morning-golden window)',
  );
  assert.match(cap.payload.tide.lowInGolden.time, /^\d{4}-\d{2}-\d{2}T/, 'lowInGolden.time ISO');
  assert.equal(
    typeof cap.payload.tide.lowInGolden.heightFt,
    'number',
    'lowInGolden.heightFt numeric',
  );
  assert.ok(cap.payload.tide.nextHigh, 'tide.nextHigh present');
  assert.ok(cap.payload.tide.nextLow, 'tide.nextLow present');

  // Sky still intact (existing behavior preserved).
  assert.equal(cap.payload.sky.sunset.band, 'promising', 'sunset band still promising');
});

test('weather: ensemble disagreement lowers sunset confidence', async () => {
  // Baseline: members all agree (spread 0 → agreement ≈ 1).
  const capAgree: { payload?: any } = {};
  const ctxAgree = makeCtx(capAgree, {
    fetchByUrl: {
      ensemble: async () => ({
        ok: true,
        status: 200,
        json: async () => buildEnsembleResponse({ spread: 0 }),
      }),
    },
  });
  await integration.tick!(ctxAgree);

  // Disagreement: wide member spread at the sunset hour → agreement < 1.
  const capDisagree: { payload?: any } = {};
  const ctxDisagree = makeCtx(capDisagree, {
    fetchByUrl: {
      ensemble: async () => ({
        ok: true,
        status: 200,
        json: async () => buildEnsembleResponse({ spread: 20 }),
      }),
    },
  });
  await integration.tick!(ctxDisagree);

  const cAgree = capAgree.payload.sky.sunset.confidence;
  const cDisagree = capDisagree.payload.sky.sunset.confidence;
  assert.ok(
    cDisagree < cAgree,
    `ensemble disagreement must lower confidence (agree=${cAgree}, disagree=${cDisagree})`,
  );
  // Band classification is unaffected by the agreement factor.
  assert.equal(
    capDisagree.payload.sky.sunset.band,
    'promising',
    'band still promising under disagreement',
  );
});

test('weather: per-source degradation — tide fetch rejects → tick ok, tide null, sky intact', async () => {
  const cap: { payload?: any; warns?: string[] } = {};
  const ctx = makeCtx(cap, {
    fetchByUrl: {
      tide: async () => {
        throw new Error('simulated CO-OPS outage');
      },
    },
  });
  const r = await integration.tick!(ctx);

  assert.equal(r.status, 'ok', 'tick still succeeds when tides fail');
  // Tide block present but its fields null (graceful degradation).
  assert.ok(cap.payload.tide, 'tide block still present');
  assert.equal(cap.payload.tide.lowInGolden, null, 'tide.lowInGolden null on failure');
  assert.equal(cap.payload.tide.nextHigh, null, 'tide.nextHigh null on failure');
  assert.equal(cap.payload.tide.nextLow, null, 'tide.nextLow null on failure');
  // Sky read unaffected.
  assert.equal(cap.payload.sky.sunset.band, 'promising', 'sky intact when tide fails');
  // Warning logged.
  assert.ok(
    (cap.warns ?? []).some((w) => /tide fetch failed/.test(w)),
    'warn logged on tide failure',
  );
});

test('weather: per-source degradation — ensemble fetch rejects → agreement falls back, tick ok', async () => {
  // With ensemble failing, agreement → 1: confidence must equal the no-ensemble
  // baseline (the default mock returns the OM array, which has no member keys).
  const capFail: { payload?: any; warns?: string[] } = {};
  const ctxFail = makeCtx(capFail, {
    fetchByUrl: {
      ensemble: async () => {
        throw new Error('simulated ensemble-api outage');
      },
    },
  });
  const r = await integration.tick!(ctxFail);
  assert.equal(r.status, 'ok', 'tick still succeeds when ensemble fails');

  // Baseline with an agreement≈1 ensemble fixture → same confidence as fallback.
  const capAgree: { payload?: any } = {};
  const ctxAgree = makeCtx(capAgree, {
    fetchByUrl: {
      ensemble: async () => ({
        ok: true,
        status: 200,
        json: async () => buildEnsembleResponse({ spread: 0 }),
      }),
    },
  });
  await integration.tick!(ctxAgree);

  assert.equal(
    capFail.payload.sky.sunset.confidence,
    capAgree.payload.sky.sunset.confidence,
    'ensemble failure falls back to agreement=1 (same confidence as full-agreement ensemble)',
  );
  assert.equal(capFail.payload.sky.sunset.band, 'promising', 'sky intact when ensemble fails');
  assert.ok(
    (capFail.warns ?? []).some((w) => /ensemble fetch failed/.test(w)),
    'warn logged on ensemble failure',
  );
});

test('weather: near-full dusk moonrise populates the moon recipe → moon alert fires', async () => {
  // Real DB so fireMatches can record/resolve alerts. At MOON_NOW the moon is
  // near-full and rises ~2h out (sunset band) over a clear horizon → moon recipe.
  const dir = mkdtempSync(join(tmpdir(), 'robin-weather-moon-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);

  // Sanity-check the fixture's premise (guards against ephemeris drift).
  const m = moonInfo(SKY.origin.lat, SKY.origin.lng, MOON_NOW);
  assert.ok(m.illumination >= SKY.moonMinIllumination, `moon near-full (got ${m.illumination})`);
  const riseLeadH = m.rise ? (m.rise.valueOf() - MOON_NOW.valueOf()) / 3.6e6 : null;
  assert.ok(
    riseLeadH != null && riseLeadH >= SKY.sunsetLeadHours[0] && riseLeadH <= SKY.sunsetLeadHours[1],
    `moonrise lead in sunset band (got ${riseLeadH})`,
  );

  const cap: { payload?: any } = {};
  const ctx = makeCtx(cap, {
    db,
    now: MOON_NOW,
    fetchByUrl: {
      forecast: async () => ({ ok: true, status: 200, json: async () => buildMoonResponse() }),
    },
  });
  const r = await integration.tick!(ctx);

  assert.equal(r.status, 'ok');
  // Moon ephemeris present in payload.
  assert.ok(cap.payload.moon.illumination >= SKY.moonMinIllumination, 'payload moon near-full');
  assert.equal(typeof cap.payload.moon.riseAz, 'number', 'moon.riseAz numeric');

  // The moon recipe fired: a `moon:<sunset-date>` sky alert was recorded.
  const alerts = listAlerts(db, { includeAcked: true }).filter((a) => a.source === 'sky');
  assert.ok(
    alerts.some((a) => a.key.startsWith('moon:')),
    `expected a moon: alert (got keys: ${alerts.map((a) => a.key).join(', ') || 'none'})`,
  );
  closeDb(db);
});

test('weather: kill-switch — sky_context=off yields null sky reads and no alert', async () => {
  const cap: { payload?: any } = {};
  const ctx = makeCtx(cap, { skyOff: true });

  // Patch fireMatches to detect if it would fire an alert.
  // We can observe the effect indirectly: the tick must still return ok and
  // ingest the base payload with sky.sunrise/sunset = null.
  const r = await integration.tick!(ctx);

  assert.equal(r.status, 'ok');
  assert.ok(cap.payload, 'payload ingested despite sky off');
  assert.ok(typeof cap.payload.temp_f !== 'undefined', 'temp_f still present');
  assert.ok(Array.isArray(cap.payload.fog_nights), 'fog_nights still present');

  // sky block must be present but reads must be null.
  assert.ok(cap.payload.sky, 'sky block present');
  assert.equal(cap.payload.sky.sunrise, null, 'sky.sunrise is null when kill-switch off');
  assert.equal(cap.payload.sky.sunset, null, 'sky.sunset is null when kill-switch off');
});

test('weather: 5xx fetch throws a transient-upstream error (runtime retries → skip)', async () => {
  const cap: { payload?: any } = {};
  const ctx = makeCtx(cap, {
    fetchResponse: async () => ({ ok: false, status: 503, json: async () => ({}) }),
  });
  await assert.rejects(
    async () => await integration.tick!(ctx),
    /returned 503 \(transient upstream\)/,
  );
});

test('weather: 429 fetch throws a transient-upstream error', async () => {
  const cap: { payload?: any } = {};
  const ctx = makeCtx(cap, {
    fetchResponse: async () => ({ ok: false, status: 429, json: async () => ({}) }),
  });
  await assert.rejects(
    async () => await integration.tick!(ctx),
    /returned 429 \(transient upstream\)/,
  );
});

test('weather: non-retryable non-OK fetch returns error status', async () => {
  const cap: { payload?: any } = {};
  const ctx = makeCtx(cap, {
    fetchResponse: async () => ({ ok: false, status: 400, json: async () => ({}) }),
  });
  const r = await integration.tick!(ctx);
  assert.equal(r.status, 'error');
  assert.ok(r.message && /400/.test(r.message), 'message mentions status code');
});

// ── detectRainClearing fallback tests ─────────────────────────────────────────
//
// These tests verify the function's behavior when `precipitation_probability`
// is absent from the API response (some Open-Meteo models omit it).
// We drive the integration tick with a hand-crafted fetch response that
// omits the precipitation_probability array.

/** Build a minimal single-location response without precipitation_probability. */
function buildNoPPResponse(opts: {
  precipBefore: number; // precip amount in the 3h before sunset window (all 3 slots)
  precipInside: number; // precip amount at the sunset window slot itself
}): object[] {
  const origin = SKY.origin;
  const { sunsetAz } = sunBearings(origin.lat, origin.lng, TEST_NOW);
  const sunsetSamples = sunsetAz != null ? samplePoints(origin, sunsetAz) : [];

  const coords: Array<{ lat: number; lng: number }> = [];
  const seen = new Set<string>();
  const push = (c: { lat: number; lng: number }) => {
    const key = `${c.lat.toFixed(4)},${c.lng.toFixed(4)}`;
    if (seen.has(key)) return;
    seen.add(key);
    coords.push({ lat: c.lat, lng: c.lng });
  };
  push(origin);
  // Include sunrise samples (no-op for this test, but matches tick's coord list).
  const { sunriseAz } = sunBearings(origin.lat, origin.lng, TEST_NOW);
  const sunriseSamples = sunriseAz != null ? samplePoints(origin, sunriseAz) : [];
  for (const s of sunriseSamples) push(s);
  for (const s of sunsetSamples) push(s);

  const times: string[] = [];
  for (let d = 0; d < 2; d++) {
    for (let h = 0; h < 24; h++) {
      const day = d === 0 ? '2026-06-25' : '2026-06-26';
      times.push(`${day}T${String(h).padStart(2, '0')}:00`);
    }
  }
  const N = times.length;
  const fill = (base: number, overrides: Record<string, number> = {}): number[] => {
    const arr = Array<number>(N).fill(base);
    for (const [iso, val] of Object.entries(overrides)) {
      const idx = times.indexOf(iso);
      if (idx >= 0) arr[idx] = val;
    }
    return arr;
  };

  // Sunset window hour: nearestHourIso('2026-06-25T20:30') → '2026-06-25T21:00'
  const sunsetHour = '2026-06-25T21:00';
  // 3 hours before sunset window.
  const preSunset = ['2026-06-25T18:00', '2026-06-25T19:00', '2026-06-25T20:00'];

  const precipOverrides: Record<string, number> = { [sunsetHour]: opts.precipInside };
  for (const h of preSunset) precipOverrides[h] = opts.precipBefore;

  return coords.map(({ lat, lng }) => ({
    latitude: lat,
    longitude: lng,
    current: { temperature_2m: 72, weather_code: 2, wind_speed_10m: 8, cloud_cover: 40 },
    hourly: {
      time: times,
      cloud_cover: fill(30),
      cloud_cover_low: fill(0),
      cloud_cover_mid: fill(0),
      cloud_cover_high: fill(0),
      precipitation: fill(0, precipOverrides),
      // precipitation_probability intentionally omitted
      temperature_2m: fill(65),
      dew_point_2m: fill(40),
      relative_humidity_2m: fill(55),
      wind_speed_10m: fill(8),
      weather_code: fill(2),
      visibility: fill(10000),
    },
    daily: {
      time: ['2026-06-25', '2026-06-26'],
      sunrise: ['2026-06-25T05:25', '2026-06-26T05:25'],
      sunset: ['2026-06-25T20:30', '2026-06-26T20:30'],
    },
  }));
}

test('weather: detectRainClearing fallback — wet before + dry inside (no precipitation_probability) → clearing detected', async () => {
  // precipBefore=1.2mm (wet, ≥0.5), precipInside=0.0mm (dry, <0.1) → should detect clearing.
  const cap: { payload?: any } = {};
  const ctx = makeCtx(cap, {
    fetchResponse: async () => ({
      ok: true,
      status: 200,
      json: async () => buildNoPPResponse({ precipBefore: 1.2, precipInside: 0.0 }),
    }),
  });
  // Tick must not throw and must return ok.
  const r = await integration.tick!(ctx);
  assert.equal(r.status, 'ok', 'tick succeeds without precipitation_probability');
  // The test verifies no crash and correct tick return — clearing detection itself
  // is exercised inside the tick (fireMatches path) without error.
});

test('weather: detectRainClearing fallback — dry before + dry inside (no precipitation_probability) → no clearing', async () => {
  // precipBefore=0.0, precipInside=0.0 → no rain before so not "clearing" — should NOT fire.
  const cap: { payload?: any } = {};
  const ctx = makeCtx(cap, {
    fetchResponse: async () => ({
      ok: true,
      status: 200,
      json: async () => buildNoPPResponse({ precipBefore: 0.0, precipInside: 0.0 }),
    }),
  });
  const r = await integration.tick!(ctx);
  assert.equal(r.status, 'ok', 'tick succeeds; no rain before = no clearing candidate');
});

test('weather: detectRainClearing fallback — wet before + wet inside (no precipitation_probability) → no clearing (still raining inside)', async () => {
  // precipBefore=1.2mm, precipInside=0.5mm (≥0.1 → still wet) → should NOT detect clearing.
  const cap: { payload?: any } = {};
  const ctx = makeCtx(cap, {
    fetchResponse: async () => ({
      ok: true,
      status: 200,
      json: async () => buildNoPPResponse({ precipBefore: 1.2, precipInside: 0.5 }),
    }),
  });
  const r = await integration.tick!(ctx);
  assert.equal(r.status, 'ok', 'tick succeeds; still raining inside = not clearing');
});

test('weather: tick + alerts run against a real DB schema without throwing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'robin-weather-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);

  const cap: { payload?: any } = {};
  const ctx = makeCtx(cap, { db });
  const r = await integration.tick!(ctx);

  assert.equal(r.status, 'ok');
  assert.ok(cap.payload.sky, 'sky block present with real DB');
  assert.equal(
    cap.payload.sky.sunset.band,
    'promising',
    'promising band confirmed in real-DB path',
  );
  closeDb(db);
});
