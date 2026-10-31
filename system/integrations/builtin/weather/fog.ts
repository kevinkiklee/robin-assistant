// Fog index for the night photography window (21:00 → 06:00 next morning).
//
// Computed from an Open-Meteo hourly forecast object (parallel arrays,
// timezone=auto). Each slot scores 0–10 as the greater of the provider's own
// fog signal (weather_code ∈ {45,48} or low visibility) and a radiation-fog
// composite (dew-point spread + relative humidity + calm wind, damped by
// nocturnal cloud blockage — a solid deck stops the radiative cooling the
// composite presumes); a night's index is the MAX over its slots, because fog
// is an event, not an average. Pure module so the scoring stays unit-testable.

/** Open-Meteo hourly parallel arrays (timezone=auto, local ISO timestamps). */
export interface OmHourly {
  time: string[];
  temperature_2m: number[];
  dew_point_2m: number[];
  relative_humidity_2m: number[];
  wind_speed_10m: number[];
  weather_code: number[];
  visibility: number[];
  /**
   * Cloud layers (%). Optional: when present they gate the radiation-fog
   * composite (see scoreNightSlot); when absent, scoring is ungated (legacy).
   */
  cloud_cover_low?: number[];
  cloud_cover_mid?: number[];
  cloud_cover_high?: number[];
}

export interface FogNight {
  /** Local date the night STARTS on — the night of `date` → `date`+1. */
  date: string;
  /** 0–10 integer; max over the night's slots. */
  index: number;
  band: 'unlikely' | 'possible' | 'likely' | 'very likely';
  /** Slot span at/near the max, e.g. "12am–6am"; null for a flat-zero night. */
  peak_window: string | null;
  /** Conditions at the peak slot, e.g. "spread 2°F · RH 96% · wind 4 mph". */
  factors: string | null;
}

/**
 * Fog-relevant signal parsed from an aerodrome TAF: the forecast's validity
 * window and the UTC ranges of every group carrying an FG or BR token. Used by
 * `applyTafGate` to cross-examine the radiation-fog composite — the composite
 * grades the MODEL's overnight spread/RH forecasts, which run wet (high scores
 * on nights that stayed clear), while the TAF tends to call those nights
 * correctly.
 */
export interface TafFogSignal {
  /** TAF validity, UTC epoch ms. */
  validFrom: number;
  validTo: number;
  /** UTC ranges of groups forecasting FG (any prefix: MIFG/BCFG/…) or BR. */
  fogRanges: Array<{ from: number; to: number }>;
}

const WMO: Record<number, string> = {
  0: 'clear',
  1: 'mainly clear',
  2: 'partly cloudy',
  3: 'overcast',
  45: 'fog',
  48: 'fog',
  51: 'drizzle',
  53: 'drizzle',
  55: 'drizzle',
  61: 'rain',
  63: 'rain',
  65: 'heavy rain',
  71: 'snow',
  73: 'snow',
  75: 'snow',
  80: 'showers',
  81: 'showers',
  82: 'heavy showers',
  95: 'thunderstorm',
};

export function wmoText(code: number): string {
  return WMO[code] ?? 'cloudy';
}

/** Linear ramp: full 10 at/below `lo`, down to 0 at/above `hi`. */
function rampDown(value: number, lo: number, hi: number): number {
  if (value <= lo) return 10;
  if (value >= hi) return 0;
  return (10 * (hi - value)) / (hi - lo);
}

/** Linear ramp: 0 at/below `lo`, up to full 10 at/above `hi`. */
function rampUp(value: number, lo: number, hi: number): number {
  if (value <= lo) return 0;
  if (value >= hi) return 10;
  return (10 * (value - lo)) / (hi - lo);
}

interface SlotScore {
  label: string;
  score: number;
  factors: string | null;
}

function band(index: number): FogNight['band'] {
  if (index >= 9) return 'very likely';
  if (index >= 6) return 'likely';
  if (index >= 3) return 'possible';
  return 'unlikely';
}

/** The night slots in order: 21:00 of day d, then 00/03/06 of day d+1. */
const NIGHT_HOURS = [
  { hour: 21, label: '9pm', nextDay: false },
  { hour: 0, label: '12am', nextDay: true },
  { hour: 3, label: '3am', nextDay: true },
  { hour: 6, label: '6am', nextDay: true },
];

function addDay(d: string): string {
  return new Date(new Date(`${d}T00:00:00Z`).valueOf() + 86400000).toISOString().slice(0, 10);
}

function scoreNightSlot(h: OmHourly, idx: number, label: string): SlotScore {
  const temp = h.temperature_2m[idx];
  const dew = h.dew_point_2m[idx];
  const rh = h.relative_humidity_2m[idx];
  const wind = h.wind_speed_10m[idx];
  const code = h.weather_code[idx];
  const vis = h.visibility[idx];
  const spread = temp - dew;
  const spreadScore = rampDown(spread, 2, 8);
  const rhScore = rampUp(rh, 85, 98);
  const windScore = rampDown(wind, 2, 14);

  // Radiation fog needs net longwave cooling at the surface; cloud re-radiates
  // it back. Weight layers by how strongly each blocks that cooling (low deck ≈
  // opaque, cirrus ≈ thin), then damp the composite linearly from 1.0 at ≤40%
  // effective blockage down to a 0.15 floor at ≥95% — under a solid deck the
  // ground never cools the last few °F to saturation (an overcast night can
  // score "likely" and still produce no fog). The provider signal below
  // stays ungated: advection/marine fog forms regardless of sky, and WMO 45/48
  // or sub-4km visibility is the provider reporting fog, not potential.
  const low = h.cloud_cover_low?.[idx];
  const mid = h.cloud_cover_mid?.[idx];
  const high = h.cloud_cover_high?.[idx];
  let cooling = 1;
  let blockage: number | null = null;
  if (low !== undefined && mid !== undefined && high !== undefined) {
    blockage = Math.min(100, low + 0.65 * mid + 0.3 * high);
    cooling = blockage <= 40 ? 1 : Math.max(0.15, 1 - (0.85 * (blockage - 40)) / 55);
  }

  const composite = (0.45 * spreadScore + 0.3 * rhScore + 0.25 * windScore) * cooling;

  // Every Open-Meteo WMO code >= 51 is precipitation (drizzle / rain / freezing
  // rain / snow / showers / thunder). Precipitation collapses the model's
  // visibility field exactly the way fog does, so reading visibility as a fog
  // signal while it rains turns every downpour into a fog night — a TAF
  // station can fall to 1SM in +TSRA with nothing resembling fog.
  // WMO 45/48 are fog proper (a code is one value, so they are never
  // simultaneously precipitating) and keep their observation-grade 10.
  const precipitating = code >= 51;
  let providerFog = 0;
  if (code === 45 || code === 48) providerFog = 10;
  else if (!precipitating) providerFog = vis < 1000 ? 8 : vis < 4000 ? 4 : 0;
  const skyNote = blockage !== null && cooling < 1 ? ` · sky ${Math.round(blockage)}% blocked` : '';
  return {
    label,
    score: Math.max(providerFog, composite),
    factors: `spread ${Math.round(spread)}°F · RH ${Math.round(rh)}% · wind ${Math.round(wind)} mph${skyNote}`,
  };
}

/**
 * Compute per-night fog outlooks from an Open-Meteo hourly object. Selects
 * slots for 21:00 on `date` and 00:00/03:00/06:00 on `date+1` by ISO string
 * matching against `hourly.time[]`. Requires ≥2 scorable slots per night.
 *
 * `todayIso` is the starting date (YYYY-MM-DD); nights are walked for each
 * unique date present in `time[]`.
 */
export function fogNights(hourly: OmHourly, todayIso: string): FogNight[] {
  // Collect the unique dates present in the time array.
  const seenDates = new Set<string>();
  for (const t of hourly.time) seenDates.add(t.slice(0, 10));
  // Build an index: ISO timestamp prefix → array index
  const timeIndex = new Map<string, number>();
  for (let i = 0; i < hourly.time.length; i++) timeIndex.set(hourly.time[i], i);

  const nights: FogNight[] = [];
  for (const date of seenDates) {
    // Only process dates from todayIso onward (skip past dates if present).
    if (date < todayIso) continue;

    const nextDate = addDay(date);
    const scored: SlotScore[] = [];

    for (const slot of NIGHT_HOURS) {
      const d = slot.nextDay ? nextDate : date;
      const hPad = String(slot.hour).padStart(2, '0');
      const key = `${d}T${hPad}:00`;
      const idx = timeIndex.get(key);
      if (idx === undefined) continue;
      scored.push(scoreNightSlot(hourly, idx, slot.label));
    }

    if (scored.length < 2) continue;

    const max = Math.max(...scored.map((s) => s.score));
    const index = Math.min(10, Math.round(max));

    let peak: string | null = null;
    let factors: string | null = null;
    if (index > 0) {
      const inPeak = scored.filter((s) => s.score >= max - 1);
      const first = inPeak[0];
      const last = inPeak[inPeak.length - 1];
      peak = first === last ? first.label : `${first.label}–${last.label}`;
      factors = scored.find((s) => s.score === max)?.factors ?? null;
    }
    nights.push({ date, index, band: band(index), peak_window: peak, factors });
  }

  // Sort by date ascending.
  nights.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return nights;
}

// ─── TAF cross-check gate ───────────────────────────────────────────────────────

/**
 * UTC epoch ms of `hour`:00 local time on `dateIso` in IANA zone `tz`.
 * Two-pass Intl correction so DST transitions resolve without a tz library.
 */
export function localHourToUtcMs(dateIso: string, hour: number, tz: string): number {
  const [y, m, d] = dateIso.split('-').map(Number);
  const want = Date.UTC(y, m - 1, d, hour);
  let utc = want; // first guess: local == UTC
  for (let i = 0; i < 2; i++) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(utc));
    const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? 0);
    const localAsUtc = Date.UTC(
      get('year'),
      get('month') - 1,
      get('day'),
      get('hour'),
      get('minute'),
    );
    utc += want - localAsUtc;
  }
  return utc;
}

/** Resolve a TAF DDHH day/hour pair to UTC ms using `ref` for month/year context. */
function resolveDayHour(dd: number, hh: number, ref: Date): number {
  let month = ref.getUTCMonth();
  let year = ref.getUTCFullYear();
  const refDay = ref.getUTCDate();
  // TAF days carry no month; a small day number near month-end means next month
  // (and a large one near month-start means last month, e.g. an old amendment).
  if (dd < refDay - 15) month += 1;
  else if (dd > refDay + 15) month -= 1;
  if (month > 11) {
    month = 0;
    year += 1;
  } else if (month < 0) {
    month = 11;
    year -= 1;
  }
  // Hour 24 is TAF-legal shorthand for 00Z of the next day; Date.UTC rolls it.
  return Date.UTC(year, month, dd, hh);
}

const FOG_TOKEN = /^[+-]?(?:MI|BC|PR|VC|FZ)?FG$/;
/**
 * Any precipitation weather token: optional intensity/proximity, optional
 * descriptors, then a precipitation type (or a bare TS/SH). Used to disqualify
 * a BR that is merely rain-reduced visibility — `-SHRA BR`, `+TSRA BR` — from
 * counting as a fog forecast.
 */
const PRECIP_TOKEN =
  /^(?:[+-]|VC)?(?:(?:MI|BC|PR|DR|BL|SH|TS|FZ)*(?:DZ|RA|SN|SG|IC|PL|GR|GS|UP)+|TS|SH)$/;
const VALIDITY = /^(\d{2})(\d{2})\/(\d{2})(\d{2})$/;

/**
 * Parse the fog-relevant skeleton out of a raw TAF. Grammar-light by design:
 * segments are delimited by FM / TEMPO / BECMG / PROBxx keywords, each segment
 * gets a UTC window (FM → until the next FM or end of validity; TEMPO/PROB →
 * their explicit window; BECMG → its window start through end of validity,
 * conservative for a "does fog appear at all" question), and a segment is
 * fog-positive iff it carries an FG-family token, or a BR token with no
 * precipitation alongside it — mist inside rain is precipitation-reduced
 * visibility and says nothing about fog. `ref` supplies
 * month/year context for the day-only TAF timestamps. Returns null when no
 * validity token is found (garbage/empty response).
 */
export function parseTafFogSignal(raw: string, ref: Date): TafFogSignal | null {
  const tokens = raw.replace(/\s+/g, ' ').trim().split(' ');
  if (tokens.length === 0) return null;
  // A raw response can concatenate several TAFs; keep the first block only.
  const secondTaf = tokens.indexOf('TAF', tokens[0] === 'TAF' ? 1 : 0);
  const scoped = secondTaf > 0 ? tokens.slice(0, secondTaf) : tokens;

  const vIdx = scoped.findIndex((t) => VALIDITY.test(t));
  if (vIdx < 0) return null;
  const vm = scoped[vIdx].match(VALIDITY) as RegExpMatchArray;
  const validFrom = resolveDayHour(Number(vm[1]), Number(vm[2]), ref);
  const validTo = resolveDayHour(Number(vm[3]), Number(vm[4]), ref);

  interface Seg {
    from: number;
    to: number;
    /** An FG-family token — fog outright. */
    fog: boolean;
    /** A BR (mist) token — fog-positive only when the segment is precipitation-free. */
    br: boolean;
    /** Any precipitation token in the same segment. */
    precip: boolean;
    prevailing: boolean;
  }
  const segs: Seg[] = [];
  const seg = (from: number, to: number, prevailing: boolean): Seg => ({
    from,
    to,
    fog: false,
    br: false,
    precip: false,
    prevailing,
  });
  let current: Seg = seg(validFrom, validTo, true);

  const closePrevailing = (at: number): void => {
    for (let k = segs.length - 1; k >= 0; k--) {
      if (segs[k].prevailing) {
        segs[k].to = at;
        return;
      }
    }
  };

  for (let i = vIdx + 1; i < scoped.length; i++) {
    const t = scoped[i];
    const fm = t.match(/^FM(\d{2})(\d{2})(\d{2})$/);
    if (fm) {
      const at = resolveDayHour(Number(fm[1]), Number(fm[2]), ref) + Number(fm[3]) * 60_000;
      if (current.prevailing) current.to = at;
      else closePrevailing(at);
      segs.push(current);
      current = seg(at, validTo, true);
      continue;
    }
    if (t === 'TEMPO' || t === 'BECMG' || /^PROB\d{2}$/.test(t)) {
      segs.push(current);
      // Window token follows (possibly after an interleaved TEMPO in "PROB30 TEMPO").
      let j = i + 1;
      if (scoped[j] === 'TEMPO') j++;
      const wm = scoped[j]?.match(VALIDITY);
      const from = wm ? resolveDayHour(Number(wm[1]), Number(wm[2]), ref) : validFrom;
      const to = wm
        ? t === 'BECMG'
          ? validTo // becoming-conditions persist after the transition window
          : resolveDayHour(Number(wm[3]), Number(wm[4]), ref)
        : validTo;
      current = seg(from, to, false);
      i = wm ? j : i;
      continue;
    }
    if (FOG_TOKEN.test(t)) current.fog = true;
    else if (t === 'BR') current.br = true;
    else if (PRECIP_TOKEN.test(t)) current.precip = true;
  }
  segs.push(current);

  const fogRanges = segs
    .filter((s) => s.fog || (s.br && !s.precip))
    .map((s) => ({ from: Math.max(s.from, validFrom), to: Math.min(s.to, validTo) }))
    .filter((r) => r.to > r.from);
  return { validFrom, validTo, fogRanges };
}

const appendFactor = (factors: string | null, note: string): string =>
  factors ? `${factors} · ${note}` : note;

/**
 * Cross-examine composite fog nights against the aerodrome TAF (the composite
 * alone can score "very likely" on a 10SM night, because it grades the model's
 * wet-biased overnight spread/RH forecasts and is allowed to override the same
 * model's own no-fog visibility field, while the TAF tends to call those nights
 * correctly).
 *
 *  - TAF fully covers the night (21:00 local → 06:00 next day) and carries NO
 *    FG/BR group overlapping it → cap the index at 4 ("possible") and say so.
 *  - A fog group overlaps the night → keep the index, annotate concurrence.
 *  - No TAF / partial coverage → keep the index, but mark a ≥6 band as
 *    model-only so a high band is never presented as confirmed on the
 *    composite alone.
 */
export function applyTafGate(nights: FogNight[], taf: TafFogSignal | null, tz: string): FogNight[] {
  return nights.map((n) => {
    const from = localHourToUtcMs(n.date, 21, tz);
    const to = localHourToUtcMs(addDay(n.date), 6, tz);
    const covered = taf !== null && taf.validFrom <= from && taf.validTo >= to;
    if (!covered) {
      return n.index >= 6
        ? { ...n, factors: appendFactor(n.factors, 'TAF unavailable — model-only, verify METAR') }
        : n;
    }
    const sig = taf as TafFogSignal;
    if (sig.fogRanges.some((r) => r.from < to && r.to > from)) {
      return { ...n, factors: appendFactor(n.factors, 'TAF concurs (FG/BR forecast)') };
    }
    if (n.index > 4) {
      return {
        ...n,
        index: 4,
        band: band(4),
        factors: appendFactor(n.factors, `TAF: no fog groups — capped from ${n.index}`),
      };
    }
    return n;
  });
}

// ── METAR: the measured pre-dawn confirmation ────────────────────────────────
//
// The composite forecasts fog; the TAF corroborates it; only a METAR *observes*
// it. The 4am/5am ticks read the configured TAF station's latest observation and the `fog_on` recipe
// turns it into the alert that decides whether the alarm was worth it.
// Reading rules (fog-index-calibration): vis < 4 mi with BR = mist forming,
// vis < 1 mi or any FG-family token = fog on. Mist inside precipitation is
// precipitation-reduced visibility and is ignored, same as the TAF gate.

export interface MetarFogSignal {
  /** Prevailing visibility in statute miles; null when the token is missing. */
  visibilityMi: number | null;
  /** An FG-family token, or visibility below 1 mi. */
  fogOn: boolean;
  /** BR with no precipitation and visibility below 4 mi, short of fogOn. */
  mistForming: boolean;
  /** ICAO id of the reporting station, set by the caller (the fetch knows it). */
  station?: string;
  /** Observation time as the METAR states it, e.g. "0851Z". */
  obsTime: string | null;
}

const VIS_TOKEN = /^(M|P)?(\d+)(?:\/(\d+))?SM$/;

/**
 * Parse the first METAR in `raw`. Returns null when no visibility token and no
 * weather token is found (garbage/empty response) — callers then skip the
 * observation rather than treat it as "no fog".
 */
export function parseMetarFogSignal(raw: string): MetarFogSignal | null {
  const line =
    raw
      .split(/\r?\n/)
      .find((l) => l.trim().length > 0)
      ?.trim() ?? '';
  if (!line) return null;
  const tokens = line.split(/\s+/);
  const rmk = tokens.indexOf('RMK');
  const body = rmk > 0 ? tokens.slice(0, rmk) : tokens;

  let visibilityMi: number | null = null;
  let fog = false;
  let mist = false;
  let precip = false;
  const obsTime = body.find((t) => /^\d{6}Z$/.test(t))?.slice(2) ?? null;

  for (let i = 0; i < body.length; i++) {
    const t = body[i];
    const vm = t.match(VIS_TOKEN);
    if (vm && visibilityMi === null) {
      let mi = Number(vm[2]);
      if (vm[3]) mi = Number(vm[2]) / Number(vm[3]);
      // "1 1/2SM": a bare whole-mile token precedes the fraction.
      if (vm[3] && i > 0 && /^\d+$/.test(body[i - 1])) mi += Number(body[i - 1]);
      visibilityMi = mi;
      continue;
    }
    if (FOG_TOKEN.test(t)) fog = true;
    else if (t === 'BR' || t === 'VCBR') mist = true;
    else if (PRECIP_TOKEN.test(t)) precip = true;
  }
  if (visibilityMi === null && !fog && !mist) return null;

  const fogOn = fog || (visibilityMi !== null && visibilityMi < 1);
  const mistForming = !fogOn && mist && !precip && visibilityMi !== null && visibilityMi < 4;
  return { visibilityMi, fogOn, mistForming, obsTime };
}
