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
  // ground never cools the last few °F to saturation (the 7/8→7/9 overcast
  // night scored "8/10 likely" and produced no fog). The provider signal below
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
  const providerFog = code === 45 || code === 48 ? 10 : vis < 1000 ? 8 : vis < 4000 ? 4 : 0;
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
