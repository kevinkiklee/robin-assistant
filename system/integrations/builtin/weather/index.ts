import { listAlerts } from '../../../kernel/runtime/alert-store.ts';
import { solarTimes, sunBearings } from '../../../lib/solar.ts';
import { colorRead } from '../../../lib/sky/color.ts';
import { SKY } from '../../../lib/sky/constants.ts';
import { fireMatches } from '../../../lib/sky/deliver.ts';
import { skyContext } from '../../../lib/sky/directional.ts';
import { samplePoints } from '../../../lib/sky/geo.ts';
import { matchRecipes } from '../../../lib/sky/recipes.ts';
import type { ColorRead, SamplePoint, Window } from '../../../lib/sky/types.ts';
import type { Integration } from '../../_runtime/types.ts';
import { type FogNight, fogNights, type OmHourly, wmoText } from './fog.ts';

/** One Open-Meteo location object (timezone=auto → local ISO timestamps). */
interface OmLocation {
  latitude: number;
  longitude: number;
  current: {
    temperature_2m: number;
    weather_code: number;
    wind_speed_10m: number;
    cloud_cover: number;
  };
  hourly: OmHourly & {
    cloud_cover: number[];
    cloud_cover_low: number[];
    cloud_cover_mid: number[];
    cloud_cover_high: number[];
    precipitation: number[];
    precipitation_probability: number[];
  };
  daily: { time: string[]; sunrise: string[]; sunset: string[] };
}

const HOURLY_FIELDS = [
  'cloud_cover',
  'cloud_cover_low',
  'cloud_cover_mid',
  'cloud_cover_high',
  'temperature_2m',
  'dew_point_2m',
  'relative_humidity_2m',
  'wind_speed_10m',
  'weather_code',
  'visibility',
  'precipitation',
  'precipitation_probability',
].join(',');

/** Local ISO date (YYYY-MM-DD) in the integration's timezone. */
function isoDateLocal(d: Date, tz = 'America/New_York'): string {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
  return p; // en-CA → YYYY-MM-DD
}

/** Round an Open-Meteo local-ISO timestamp ("YYYY-MM-DDTHH:MM") to its nearest hour bucket. */
function nearestHourIso(localIso: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(localIso);
  if (!m) return localIso;
  const [, date, hh, mm] = m;
  let hour = Number(hh) + (Number(mm) >= 30 ? 1 : 0);
  // 23:30+ rolls into the next day; advance the date.
  let d = date;
  if (hour >= 24) {
    hour -= 24;
    d = new Date(new Date(`${date}T00:00:00Z`).valueOf() + 86400000).toISOString().slice(0, 10);
  }
  return `${d}T${String(hour).padStart(2, '0')}:00`;
}

import type { CloudLayers } from '../../../lib/sky/types.ts';

/**
 * Cloud layers for `loc` at the rounded local hour `hourIso`. Returns null
 * when the location is missing or the hour is not in the forecast, so callers
 * can distinguish "no data" from a genuinely clear sky (coverage confidence).
 */
function layersAt(loc: OmLocation | undefined, hourIso: string): CloudLayers | null {
  if (!loc) return null;
  const idx = loc.hourly?.time?.indexOf(hourIso) ?? -1;
  if (idx === -1) return null;
  return {
    low: loc.hourly.cloud_cover_low?.[idx] ?? 0,
    mid: loc.hourly.cloud_cover_mid?.[idx] ?? 0,
    high: loc.hourly.cloud_cover_high?.[idx] ?? 0,
  };
}

export const integration: Integration = {
  async tick(ctx) {
    const now = ctx.now();
    const tz = 'America/New_York';
    const lat = Number(ctx.state.get('lat')) || SKY.origin.lat;
    const lng = Number(ctx.state.get('lng')) || SKY.origin.lng;
    const origin = { lat, lng };
    const skyEnabled = ctx.state.get('sky_context') !== 'off';
    const alertsEnabled = ctx.state.get('sky_alerts') !== 'off';

    // Sun bearings drive the directional sampling fans for both windows.
    const { sunriseAz, sunsetAz } = sunBearings(lat, lng, now);

    // Build the request coord list: origin first, then both windows' sample
    // fans, deduped on rounded lat/lng. We retain the per-window coord lists so
    // each window can rebuild its SamplePoint[] from the right far/near fans.
    const sunriseSamples = sunriseAz != null ? samplePoints(origin, sunriseAz) : [];
    const sunsetSamples = sunsetAz != null ? samplePoints(origin, sunsetAz) : [];
    const coords: Array<{ lat: number; lng: number }> = [];
    const seen = new Set<string>();
    const pushCoord = (c: { lat: number; lng: number }) => {
      const key = `${c.lat.toFixed(4)},${c.lng.toFixed(4)}`;
      if (seen.has(key)) return;
      seen.add(key);
      coords.push({ lat: c.lat, lng: c.lng });
    };
    pushCoord(origin);
    for (const s of [...sunriseSamples, ...sunsetSamples]) pushCoord(s);

    const latCsv = coords.map((c) => c.lat.toFixed(4)).join(',');
    const lngCsv = coords.map((c) => c.lng.toFixed(4)).join(',');
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${latCsv}&longitude=${lngCsv}` +
      `&timezone=auto&temperature_unit=fahrenheit&wind_speed_unit=mph&forecast_days=2` +
      `&current=temperature_2m,weather_code,wind_speed_10m,cloud_cover` +
      `&hourly=${HOURLY_FIELDS}&daily=sunrise,sunset`;

    const res = await ctx.fetch(url);
    if (!res.ok) {
      return { status: 'error', message: `open-meteo returned ${res.status}` };
    }

    // Multi-coordinate responses are an array (request order); a single coord
    // is a bare object. Normalize to an array; data[0] is the origin.
    const raw = (await res.json()) as OmLocation | OmLocation[];
    const data = (Array.isArray(raw) ? raw : [raw]) as OmLocation[];
    const originLoc = data[0];
    if (!originLoc?.current || !originLoc.hourly?.time) {
      return { status: 'error', message: 'open-meteo response missing origin data' };
    }

    // Map a sample (origin-relative coord) → the matching response location by
    // rounded lat/lng, so each SamplePoint reads its own forecast column.
    const byCoord = new Map<string, OmLocation>();
    for (const loc of data) {
      byCoord.set(`${loc.latitude.toFixed(4)},${loc.longitude.toFixed(4)}`, loc);
    }
    const locFor = (lt: number, ln: number) =>
      byCoord.get(`${lt.toFixed(4)},${ln.toFixed(4)}`);

    // --- Base scalars + sun windows + fog (always ingested) ---
    const current = originLoc.current;
    const desc = wmoText(current.weather_code);
    const temp_f = current.temperature_2m;
    const wind_mph = current.wind_speed_10m;
    const cloud_cover = current.cloud_cover;

    const fog: FogNight[] = fogNights(originLoc.hourly as OmHourly, isoDateLocal(now, tz));
    const fogNote = fog.length > 0 ? ` · fog tonight ${fog[0].index}/10 (${fog[0].band})` : '';

    const s = solarTimes(lat, lng, now);
    const sun = {
      sunrise: s.sunrise?.toISOString() ?? null,
      sunset: s.sunset?.toISOString() ?? null,
      golden_hour_morning_end: s.goldenHourMorningEnd?.toISOString() ?? null,
      golden_hour_evening_start: s.goldenHourEveningStart?.toISOString() ?? null,
      blue_hour_morning_start: s.blueHourMorningStart?.toISOString() ?? null,
      blue_hour_evening_end: s.blueHourEveningEnd?.toISOString() ?? null,
    };

    // --- Directional sky reads (gated) ---
    let sunriseRead: ColorRead | null = null;
    let sunsetRead: ColorRead | null = null;
    let sunriseLeadH: number | undefined;
    let sunsetLeadH: number | undefined;
    let sunriseDate = isoDateLocal(now, tz);
    let sunsetDate = isoDateLocal(now, tz);
    let sunriseHourIso = '';
    let sunsetHourIso = '';

    const buildSamples = (
      samples: Array<{ distKm: number; bearing: number; lat: number; lng: number }>,
      hourIso: string,
    ): { points: SamplePoint[]; coverage: number } => {
      let found = 0;
      const points = samples.map((sp) => {
        const result = layersAt(locFor(sp.lat, sp.lng), hourIso);
        if (result !== null) found++;
        return {
          distKm: sp.distKm,
          bearing: sp.bearing,
          lat: sp.lat,
          lng: sp.lng,
          layers: result ?? { low: 0, mid: 0, high: 0 },
        };
      });
      const coverage = samples.length ? found / samples.length : 0;
      return { points, coverage };
    };

    if (skyEnabled) {
      const daily = originLoc.daily;
      // Sunset: use today's sunset; if it has already passed, fall back to
      // tomorrow's (daily index 1).
      if (sunsetAz != null && daily?.sunset?.length) {
        const todaySunset = s.sunset ?? null;
        const useTomorrowSunset = todaySunset != null && todaySunset.valueOf() <= now.valueOf();
        const sunsetStr = daily.sunset[useTomorrowSunset ? 1 : 0] ?? daily.sunset[0];
        sunsetHourIso = nearestHourIso(sunsetStr);
        sunsetDate = sunsetStr.slice(0, 10);
        const instant = useTomorrowSunset
          ? solarTimes(lat, lng, new Date(now.valueOf() + 86400000)).sunset
          : todaySunset;
        if (instant) sunsetLeadH = (instant.valueOf() - now.valueOf()) / 3.6e6;
        const { points: sunsetPoints, coverage: sunsetCoverage } = buildSamples(sunsetSamples, sunsetHourIso);
        const ctxOut = skyContext({
          window: 'sunset' as Window,
          azimuth: sunsetAz,
          samples: sunsetPoints,
          leadHours: sunsetLeadH ?? 0,
          coverage: sunsetCoverage,
        });
        sunsetRead = colorRead(ctxOut);
      }

      // Sunrise: night-before heads-up uses tomorrow's sunrise when today's has
      // already happened (daily index 1; forecast_days=2 guarantees it).
      if (sunriseAz != null && daily?.sunrise?.length) {
        const todaySunrise = s.sunrise ?? null;
        const useTomorrowSunrise =
          todaySunrise != null && todaySunrise.valueOf() <= now.valueOf();
        const sunriseStr = daily.sunrise[useTomorrowSunrise ? 1 : 0] ?? daily.sunrise[0];
        sunriseHourIso = nearestHourIso(sunriseStr);
        sunriseDate = sunriseStr.slice(0, 10);
        const instant = useTomorrowSunrise
          ? solarTimes(lat, lng, new Date(now.valueOf() + 86400000)).sunrise
          : todaySunrise;
        if (instant) sunriseLeadH = (instant.valueOf() - now.valueOf()) / 3.6e6;
        const { points: sunrisePoints, coverage: sunriseCoverage } = buildSamples(sunriseSamples, sunriseHourIso);
        const ctxOut = skyContext({
          window: 'sunrise' as Window,
          azimuth: sunriseAz,
          samples: sunrisePoints,
          leadHours: sunriseLeadH ?? 0,
          coverage: sunriseCoverage,
        });
        sunriseRead = colorRead(ctxOut);
      }
    }

    const summary =
      `Weather (Astoria): ${Math.round(temp_f)}°F, ${desc}${fogNote}` +
      (sunsetRead ? ` · sunset ${sunsetRead.band}` : '');

    await ctx.ingest({
      kind: 'integration.tick',
      source: 'weather',
      content: summary,
      payload: {
        kind: 'current',
        location: 'Astoria',
        temp_f,
        desc,
        wind_mph,
        cloud_cover,
        fog_nights: fog,
        ...sun,
        sky: {
          asOf: now.toISOString(),
          sunrise: sunriseRead,
          sunset: sunsetRead,
        },
      },
    });

    // --- Light proactive alerts (gated) ---
    if (alertsEnabled && skyEnabled) {
      // Tonight's fog peak overlapping the sunrise hour → fog_sunrise candidate.
      const tonight = fog[0];
      const fogIndex = tonight?.index;
      const sunriseHourLabel = sunriseHourIso ? Number(sunriseHourIso.slice(11, 13)) : null;
      const fogCoversSunrise =
        !!tonight?.peak_window &&
        sunriseHourLabel != null &&
        peakWindowCoversHour(tonight.peak_window, sunriseHourLabel);

      // Rain clearing: wet in the hours before the sunset window, dry (<20%
      // precip probability) inside it.
      const rainClearing = sunsetHourIso ? detectRainClearing(originLoc, sunsetHourIso) : false;

      const matches = matchRecipes({
        sunrise: sunriseRead,
        sunset: sunsetRead,
        sunriseLeadH,
        sunsetLeadH,
        fogIndex,
        fogCoversSunrise,
        rainClearing,
        dates: { sunrise: sunriseDate, sunset: sunsetDate },
      });

      const openKeys = listAlerts(ctx.db, { includeAcked: true })
        .filter((a) => a.source === 'sky')
        .map((a) => a.key);
      await fireMatches({ db: ctx.db, matches, openKeys });
    }

    ctx.state.set('last_sync', now.toISOString());
    return { status: 'ok', ingested: 1 };
  },

  async health(ctx) {
    const last = ctx.state.get('last_sync');
    return { ok: true, message: last ? `last sync: ${last}` : 'never synced' };
  },
};

/** A peak_window like "12am–6am" or "3am" — does it span the given 24h hour? */
function peakWindowCoversHour(peak: string, hour: number): boolean {
  const parse = (label: string): number | null => {
    const m = /^(\d{1,2})(am|pm)$/.exec(label.trim());
    if (!m) return null;
    let h = Number(m[1]) % 12;
    if (m[2] === 'pm') h += 12;
    return h;
  };
  const parts = peak.split('–');
  const lo = parse(parts[0]);
  const hi = parts[1] ? parse(parts[1]) : lo;
  if (lo == null || hi == null) return false;
  return lo <= hi ? hour >= lo && hour <= hi : hour >= lo || hour <= hi; // wrap past midnight
}

/**
 * Wet before the sunset window, clearing to <20% precip probability inside it.
 *
 * Defensive fallback: some Open-Meteo model responses omit
 * `precipitation_probability` entirely.  When a slot's probability is absent
 * we fall back to the raw `precipitation` amount:
 *   - "inside is dry"  → precip < 0.1 mm  (instead of prob < 20%)
 *   - "pre-window wet" → precip ≥ 0.5 mm  (same threshold already used)
 */
function detectRainClearing(loc: OmLocation, sunsetHourIso: string): boolean {
  const times = loc.hourly?.time ?? [];
  const idx = times.indexOf(sunsetHourIso);
  if (idx < 0) return false;

  const ppArray = loc.hourly.precipitation_probability;
  const insideProb = ppArray?.[idx];
  if (insideProb !== undefined) {
    // precipitation_probability is present: use it as the primary signal.
    if (insideProb >= 20) return false;
  } else {
    // Fallback: treat precipitation amount as the dry-inside proxy.
    if ((loc.hourly.precipitation?.[idx] ?? 0) >= 0.1) return false;
  }

  // Any meaningful precip in the 3 hours before the window?
  for (let i = Math.max(0, idx - 3); i < idx; i++) {
    const p = loc.hourly.precipitation?.[i] ?? 0;
    const pp = ppArray?.[i]; // may be undefined when the array is absent
    if (p >= 0.5 || (pp !== undefined && pp >= 50)) return true;
  }
  return false;
}
