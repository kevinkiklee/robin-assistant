// Fog index for the night photography window (21:00 → 06:00 next morning).
//
// Computed from the wttr.in `j1` 3-day hourly forecast the weather tick already
// fetches — no extra network call. Each 3-hour forecast slot scores 0–10 as the
// greater of the provider's own `chanceoffog` and a radiation-fog composite
// (dew-point spread + relative humidity + calm wind); a night's index is the
// MAX over its slots, because fog is an event, not an average. Pure module so
// the scoring stays unit-testable.

/** The subset of a wttr.in `j1` hourly slot the fog index reads (all strings). */
export interface WttrHour {
  time?: string; // minutes-less "HHmm" without padding: "0", "300", … "2100"
  tempF?: string;
  DewPointF?: string;
  humidity?: string;
  windspeedMiles?: string;
  chanceoffog?: string;
}

export interface WttrDay {
  date?: string; // YYYY-MM-DD (provider-local)
  hourly?: WttrHour[];
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

function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
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

/**
 * Score one forecast slot 0–10. Returns null when the slot carries none of the
 * fields the index reads (rather than scoring an empty slot as calm-and-clear).
 */
export function scoreSlot(h: WttrHour, label: string): SlotScore | null {
  const temp = toNum(h.tempF);
  const dew = toNum(h.DewPointF);
  const rh = toNum(h.humidity);
  const wind = toNum(h.windspeedMiles);
  const cf = toNum(h.chanceoffog);
  if (temp === null && dew === null && rh === null && cf === null) return null;

  // Radiation-fog composite. Dew-point spread is the dominant predictor:
  // saturation (spread ≤ ~2°F) with calm air is the classic fog setup.
  const spread = temp !== null && dew !== null ? temp - dew : null;
  const spreadScore = spread !== null ? rampDown(spread, 2, 8) : 0;
  const rhScore = rh !== null ? rampUp(rh, 85, 98) : 0;
  const windScore = wind !== null ? rampDown(wind, 2, 14) : 5; // unknown wind = neutral
  const composite = 0.45 * spreadScore + 0.3 * rhScore + 0.25 * windScore;

  const score = Math.max(cf !== null ? cf / 10 : 0, composite);
  const factors: string[] = [];
  if (spread !== null) factors.push(`spread ${Math.round(spread)}°F`);
  if (rh !== null) factors.push(`RH ${Math.round(rh)}%`);
  if (wind !== null) factors.push(`wind ${Math.round(wind)} mph`);
  return { label, score, factors: factors.length > 0 ? factors.join(' · ') : null };
}

function band(index: number): FogNight['band'] {
  if (index >= 9) return 'very likely';
  if (index >= 6) return 'likely';
  if (index >= 3) return 'possible';
  return 'unlikely';
}

function hourAt(day: WttrDay | undefined, time: string): WttrHour | undefined {
  return day?.hourly?.find((h) => h.time === time);
}

/** The night slots, in order: 9pm of day d, then 12am/3am/6am of day d+1. */
const NIGHT_SLOTS: Array<{ time: string; label: string; nextDay: boolean }> = [
  { time: '2100', label: '9pm', nextDay: false },
  { time: '0', label: '12am', nextDay: true },
  { time: '300', label: '3am', nextDay: true },
  { time: '600', label: '6am', nextDay: true },
];

/**
 * Compute per-night fog outlooks from the forecast days. A night needs at
 * least two scorable slots to be reported; the last forecast day only
 * contributes its 9pm slot, so it is usually dropped.
 */
export function fogNights(days: WttrDay[]): FogNight[] {
  const nights: FogNight[] = [];
  for (let i = 0; i < days.length; i++) {
    const date = days[i]?.date;
    if (!date) continue;
    const scored: SlotScore[] = [];
    for (const slot of NIGHT_SLOTS) {
      const day = slot.nextDay ? days[i + 1] : days[i];
      const hour = hourAt(day, slot.time);
      if (!hour) continue;
      const s = scoreSlot(hour, slot.label);
      if (s) scored.push(s);
    }
    if (scored.length < 2) continue;

    const max = Math.max(...scored.map((s) => s.score));
    const index = Math.min(10, Math.round(max));
    // Peak = the contiguous run of slots within one point of the max.
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
  return nights;
}
