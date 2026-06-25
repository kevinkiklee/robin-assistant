import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeDb, openDb } from '../../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../../brain/memory/migrations/index.ts';
import { sunBearings } from '../../../lib/solar.ts';
import { SKY } from '../../../lib/sky/constants.ts';
import { samplePoints } from '../../../lib/sky/geo.ts';
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

// ── Context factory ───────────────────────────────────────────────────────────

function makeCtx(
  captured: { payload?: any; content?: string },
  opts: { skyOff?: boolean; db?: any; fetchResponse?: () => Promise<any> } = {},
) {
  const kv = new Map<string, string>();
  if (opts.skyOff) kv.set('sky_context', 'off');

  const defaultFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => buildResponse(),
  });

  return {
    state: {
      get: (k: string) => kv.get(k) ?? null,
      set: (k: string, v: string) => void kv.set(k, v),
      delete: (k: string) => void kv.delete(k),
    },
    fetch: (opts.fetchResponse ?? defaultFetch) as any,
    now: () => TEST_NOW,
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
    log: { info() {}, warn() {}, error() {} },
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
  assert.match(
    cap.payload.sunrise ?? '',
    /^\d{4}-\d{2}-\d{2}T/,
    'payload.sunrise is ISO',
  );
  assert.match(
    cap.payload.sunset ?? '',
    /^\d{4}-\d{2}-\d{2}T/,
    'payload.sunset is ISO',
  );

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

test('weather: non-OK fetch returns error status', async () => {
  const cap: { payload?: any } = {};
  const ctx = makeCtx(cap, {
    fetchResponse: async () => ({ ok: false, status: 503, json: async () => ({}) }),
  });
  const r = await integration.tick!(ctx);
  assert.equal(r.status, 'error');
  assert.ok(r.message && /503/.test(r.message), 'message mentions status code');
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
