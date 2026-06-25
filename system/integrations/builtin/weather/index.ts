import { listAlerts } from '../../../kernel/runtime/alert-store.ts';
import { type MoonInfo, moonInfo } from '../../../lib/lunar.ts';
import { solarTimes, sunBearings } from '../../../lib/solar.ts';
import { colorRead } from '../../../lib/sky/color.ts';
import { SKY } from '../../../lib/sky/constants.ts';
import { fireMatches } from '../../../lib/sky/deliver.ts';
import { skyContext } from '../../../lib/sky/directional.ts';
import { agreementFactor } from '../../../lib/sky/ensemble.ts';
import { samplePoints } from '../../../lib/sky/geo.ts';
import { matchRecipes } from '../../../lib/sky/recipes.ts';
import type { ColorRead, SamplePoint, Window } from '../../../lib/sky/types.ts';
import { lowTideInWindow, nextTides, parseTides } from '../../../lib/tides.ts';
import type { Integration } from '../../_runtime/types.ts';
import { type FogNight, fogNights, type OmHourly, wmoText } from './fog.ts';

/** Default NOAA CO-OPS tide-prediction station: Beach Channel (bridge), Jamaica Bay, NY. */
const DEFAULT_TIDE_STATION = '8517137';

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

    // --- Moon: near-full moonset near dawn (→sunrise/west) or moonrise near dusk
    // (→sunset/east). Eligibility is known up front from the ephemeris, so we can
    // fold the moon-azimuth sample fan into the single batched Open-Meteo request.
    const moon: MoonInfo = moonInfo(lat, lng, now);
    const leadH = (t: Date | null): number | null =>
      t ? (t.valueOf() - now.valueOf()) / 3.6e6 : null;
    const inBand = (h: number | null, [lo, hi]: readonly [number, number]) =>
      h != null && h >= lo && h <= hi;

    // Each candidate ties a moon event to the window whose light it complements.
    type MoonEvent = {
      window: Window;
      event: 'rise' | 'set';
      eventTime: Date;
      azimuth: number;
      leadH: number;
    };
    const moonCandidates: MoonEvent[] = [];
    if (skyEnabled && moon.illumination >= SKY.moonMinIllumination) {
      const setLead = leadH(moon.set);
      if (moon.set && moon.setAz != null && inBand(setLead, SKY.sunriseLeadHours)) {
        moonCandidates.push({
          window: 'sunrise',
          event: 'set',
          eventTime: moon.set,
          azimuth: moon.setAz,
          leadH: setLead as number,
        });
      }
      const riseLead = leadH(moon.rise);
      if (moon.rise && moon.riseAz != null && inBand(riseLead, SKY.sunsetLeadHours)) {
        moonCandidates.push({
          window: 'sunset',
          event: 'rise',
          eventTime: moon.rise,
          azimuth: moon.riseAz,
          leadH: riseLead as number,
        });
      }
    }
    // Fold each candidate's azimuth fan into the batched coord list.
    const moonSamples = new Map<Window, ReturnType<typeof samplePoints>>();
    for (const c of moonCandidates) {
      const fan = samplePoints(origin, c.azimuth);
      moonSamples.set(c.window, fan);
      for (const sp of fan) pushCoord(sp);
    }

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

    // --- Ensemble agreement (Open-Meteo ensemble; per-source degradation) ---
    // Members appear as `cloud_cover_member01..NN` (numbering starts at 01); the
    // bare `cloud_cover` key is the control run, which we exclude from spread.
    // On any failure agreementAt() returns 1 (lead-time confidence only), since
    // ensembleHourly stays null.
    let ensembleHourly: Record<string, unknown> | null = null;
    let ensembleTimes: string[] = [];
    if (skyEnabled) {
      try {
        const ensUrl =
          `https://ensemble-api.open-meteo.com/v1/ensemble?latitude=${lat.toFixed(4)}` +
          `&longitude=${lng.toFixed(4)}&hourly=cloud_cover&models=icon_seamless` +
          `&forecast_days=2&timezone=auto`;
        const ensRes = await ctx.fetch(ensUrl);
        if (!ensRes.ok) throw new Error(`ensemble-api returned ${ensRes.status}`);
        const ensRaw = (await ensRes.json()) as { hourly?: Record<string, unknown> };
        const h = ensRaw.hourly;
        if (h && Array.isArray(h.time)) {
          ensembleHourly = h;
          ensembleTimes = h.time as string[];
        }
      } catch (err) {
        ctx.log.warn(`weather: ensemble fetch failed, agreement→1 (${(err as Error).message})`);
      }
    }

    /** Member-spread agreement factor at a rounded local hour, or 1 if unavailable. */
    const agreementAt = (hourIso: string): number => {
      if (!ensembleHourly || !ensembleTimes.length) return 1;
      const idx = ensembleTimes.indexOf(hourIso);
      if (idx < 0) return 1;
      const members: number[] = [];
      for (const [key, arr] of Object.entries(ensembleHourly)) {
        if (!/^cloud_cover_member\d+$/.test(key)) continue;
        const v = Array.isArray(arr) ? (arr[idx] as number | null) : null;
        if (typeof v === 'number' && Number.isFinite(v)) members.push(v);
      }
      return members.length >= 2 ? agreementFactor(members) : 1;
    };

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

    // --- Tides (NOAA CO-OPS; gated + per-source degradation) ---
    // Morning-golden low tide near Jamaica Bay → exposed flats for shorebirds.
    // Needs the solar window (s) → computed after base scalars. Any failure logs
    // and leaves every tide field null; the tick still succeeds.
    const tideEnabled = ctx.state.get('sky_tide') !== 'off';
    const tideStationRaw = ctx.state.get('tide_station');
    const tideStation = tideStationRaw && /^\d+$/.test(tideStationRaw) ? tideStationRaw : DEFAULT_TIDE_STATION;
    let tideMorningLow: { time: Date; heightFt: number } | null = null;
    let tideNextHigh: { time: Date; heightFt: number } | null = null;
    let tideNextLow: { time: Date; heightFt: number } | null = null;
    if (skyEnabled && tideEnabled) {
      try {
        const today = isoDateLocal(now, tz).replace(/-/g, '');
        const tideUrl =
          `https://api.tidesandcurrents.gov/api/prod/datagetter?product=predictions` +
          `&interval=hilo&datum=MLLW&units=english&time_zone=lst_ldt&format=json` +
          `&station=${tideStation}&begin_date=${today}&range=48`;
        const tideRes = await ctx.fetch(tideUrl);
        if (!tideRes.ok) throw new Error(`tidesandcurrents returned ${tideRes.status}`);
        const tides = parseTides(await tideRes.json());
        const next = nextTides(tides, now);
        tideNextHigh = next.high ? { time: next.high.time, heightFt: next.high.heightFt } : null;
        tideNextLow = next.low ? { time: next.low.time, heightFt: next.low.heightFt } : null;
        // Morning-golden low: between sunrise and the end of morning golden hour.
        // Tide times (CO-OPS lst_ldt) and `now` are compared as absolute instants;
        // this assumes the host TZ matches the station TZ (America/New_York for Jamaica Bay).
        const srInstant = s.sunrise ?? null;
        const ghEnd = s.goldenHourMorningEnd ?? null;
        if (srInstant && ghEnd) {
          const low = lowTideInWindow(tides, srInstant, ghEnd);
          if (low) tideMorningLow = { time: low.time, heightFt: low.heightFt };
        }
      } catch (err) {
        ctx.log.warn(`weather: tide fetch failed, tide→null (${(err as Error).message})`);
        tideMorningLow = null;
        tideNextHigh = null;
        tideNextLow = null;
      }
    }

    // --- Directional sky reads (gated) ---
    let sunriseRead: ColorRead | null = null;
    let sunsetRead: ColorRead | null = null;
    let sunriseLeadH: number | undefined;
    let sunsetLeadH: number | undefined;
    let sunriseDate = isoDateLocal(now, tz);
    let sunsetDate = isoDateLocal(now, tz);
    let sunriseHourIso = '';
    let sunsetHourIso = '';
    // The single moon recipe input (dawn moonset → sunrise, dusk moonrise →
    // sunset). Null when the moon isn't near-full or no event is near a window.
    let moonInput: NonNullable<Parameters<typeof matchRecipes>[0]['moon']> | null = null;

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
          agreement: agreementAt(sunsetHourIso),
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
          agreement: agreementAt(sunriseHourIso),
        });
        sunriseRead = colorRead(ctxOut);
      }

      // Moon: run a directional read at each eligible moon event's azimuth using
      // the fan we already folded into the batched request. The window's sun hour
      // is the best available proxy for the moon-event hour's cloud forecast.
      for (const c of moonCandidates) {
        const fan = moonSamples.get(c.window);
        if (!fan) continue;
        const hourIso = c.window === 'sunrise' ? sunriseHourIso : sunsetHourIso;
        if (!hourIso) continue;
        const { points } = buildSamples(fan, hourIso);
        const moonCtx = skyContext({
          window: c.window,
          azimuth: c.azimuth,
          samples: points,
          leadHours: c.leadH,
          coverage: 1,
          agreement: agreementAt(hourIso),
        });
        moonInput = {
          illumination: moon.illumination,
          event: c.event,
          eventTime: c.eventTime,
          azimuth: c.azimuth,
          horizonClear: moonCtx.horizonGap,
          phaseName: moon.phaseName,
          leadH: c.leadH,
          window: c.window,
        };
        // One moon block feeds the recipe; sunrise (dawn moonset) wins if both
        // events qualify in the same tick (prefer the earlier-in-the-day light).
        if (c.window === 'sunrise') break;
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
        moon: {
          rise: moon.rise?.toISOString() ?? null,
          set: moon.set?.toISOString() ?? null,
          riseAz: moon.riseAz,
          setAz: moon.setAz,
          illumination: moon.illumination,
          phaseName: moon.phaseName,
        },
        tide: {
          nextHigh: tideNextHigh
            ? { time: tideNextHigh.time.toISOString(), heightFt: tideNextHigh.heightFt }
            : null,
          nextLow: tideNextLow
            ? { time: tideNextLow.time.toISOString(), heightFt: tideNextLow.heightFt }
            : null,
          lowInGolden: tideMorningLow
            ? { time: tideMorningLow.time.toISOString(), heightFt: tideMorningLow.heightFt }
            : null,
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

      const tideInput = tideMorningLow
        ? {
            low: { time: tideMorningLow.time, heightFt: tideMorningLow.heightFt },
            leadH: (tideMorningLow.time.valueOf() - now.valueOf()) / 3.6e6,
          }
        : null;

      const matches = matchRecipes({
        sunrise: sunriseRead,
        sunset: sunsetRead,
        sunriseLeadH,
        sunsetLeadH,
        fogIndex,
        fogCoversSunrise,
        rainClearing,
        moon: moonInput,
        tide: tideInput,
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
