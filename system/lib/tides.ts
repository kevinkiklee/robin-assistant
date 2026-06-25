export interface Tide {
  time: Date;
  type: 'H' | 'L';
  heightFt: number;
}

/**
 * Parse a NOAA CO-OPS predictions JSON response into Tide objects.
 * Tolerant: missing/empty predictions array, missing fields, unparseable values
 * are silently skipped. Never throws.
 */
export function parseTides(json: unknown): Tide[] {
  if (json === null || typeof json !== 'object') return [];
  const raw = (json as Record<string, unknown>).predictions;
  if (!Array.isArray(raw)) return [];

  const tides: Tide[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue;
    const { t, v, type } = item as Record<string, unknown>;
    if (typeof t !== 'string' || typeof v !== 'string') continue;
    if (type !== 'H' && type !== 'L') continue;

    // Parse "YYYY-MM-DD HH:mm" as local time by inserting the 'T' separator.
    // new Date("2026-06-25T03:12") is treated as local time per the spec.
    const isoLocal = t.replace(' ', 'T');
    const time = new Date(isoLocal);
    if (isNaN(time.getTime())) continue;

    const heightFt = parseFloat(v);
    if (isNaN(heightFt)) continue;

    tides.push({ time, type, heightFt });
  }
  return tides;
}

/**
 * Returns the first LOW tide whose time falls within [start, end] (inclusive),
 * or null if none overlap the window.
 */
export function lowTideInWindow(tides: Tide[], start: Date, end: Date): Tide | null {
  const s = start.getTime();
  const e = end.getTime();
  for (const tide of tides) {
    if (tide.type === 'L') {
      const t = tide.time.getTime();
      if (t >= s && t <= e) return tide;
    }
  }
  return null;
}

/**
 * Returns the next high and next low tide strictly after `from`.
 * Either can be null if no such tide exists in the provided array.
 */
export function nextTides(
  tides: Tide[],
  from: Date,
): { high: Tide | null; low: Tide | null } {
  const f = from.getTime();
  let high: Tide | null = null;
  let low: Tide | null = null;

  for (const tide of tides) {
    if (tide.time.getTime() <= f) continue;
    if (tide.type === 'H' && high === null) high = tide;
    if (tide.type === 'L' && low === null) low = tide;
    if (high !== null && low !== null) break;
  }

  return { high, low };
}
