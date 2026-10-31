export interface SolarTimes {
  sunrise: Date | null;
  sunset: Date | null;
  goldenHourMorningEnd: Date | null; // sun reaches +6° ascending
  goldenHourEveningStart: Date | null; // sun at +6° descending
  blueHourMorningStart: Date | null; // sun at -6° ascending
  blueHourEveningEnd: Date | null; // sun at -6° descending
}

const rad = Math.PI / 180;

function eqTimeAndDecl(date: Date): { eqTime: number; declRad: number } {
  // Fractional year (radians), per NOAA, using day-of-year.
  const start = Date.UTC(date.getUTCFullYear(), 0, 0);
  const doy = Math.floor(
    (Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - start) / 86400000,
  );
  const gamma = ((2 * Math.PI) / 365) * (doy - 1 + 0.5);
  const eqTime =
    229.18 *
    (0.000075 +
      0.001868 * Math.cos(gamma) -
      0.032077 * Math.sin(gamma) -
      0.014615 * Math.cos(2 * gamma) -
      0.040849 * Math.sin(2 * gamma));
  const declRad =
    0.006918 -
    0.399912 * Math.cos(gamma) +
    0.070257 * Math.sin(gamma) -
    0.006758 * Math.cos(2 * gamma) +
    0.000907 * Math.sin(2 * gamma) -
    0.002697 * Math.cos(3 * gamma) +
    0.00148 * Math.sin(3 * gamma);
  return { eqTime, declRad };
}

function minutesToDate(date: Date, utcMinutes: number): Date {
  const base = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  return new Date(base + utcMinutes * 60000);
}

function hourAngleDeg(altitudeDeg: number, latRad: number, declRad: number): number | null {
  const zRad = (90 - altitudeDeg) * rad;
  const arg =
    Math.cos(zRad) / (Math.cos(latRad) * Math.cos(declRad)) - Math.tan(latRad) * Math.tan(declRad);
  if (arg < -1 || arg > 1) return null;
  return Math.acos(arg) / rad;
}

export function solarTimes(lat: number, lng: number, date: Date): SolarTimes {
  const latRad = lat * rad;
  const { eqTime, declRad } = eqTimeAndDecl(date);
  const at = (altitude: number, side: 'rise' | 'set'): Date | null => {
    const ha = hourAngleDeg(altitude, latRad, declRad);
    if (ha === null) return null;
    const min = side === 'rise' ? 720 - 4 * (lng + ha) - eqTime : 720 - 4 * (lng - ha) - eqTime;
    return minutesToDate(date, min);
  };
  return {
    sunrise: at(-0.833, 'rise'),
    sunset: at(-0.833, 'set'),
    goldenHourMorningEnd: at(6, 'rise'),
    goldenHourEveningStart: at(6, 'set'),
    blueHourMorningStart: at(-6, 'rise'),
    blueHourEveningEnd: at(-6, 'set'),
  };
}

export interface SunBearings {
  sunriseAz: number | null;
  sunsetAz: number | null;
}

/** Compass bearing (deg from N) where the sun crosses the horizon (alt −0.833°). */
export function sunBearings(lat: number, _lng: number, date: Date): SunBearings {
  // Longitude does not affect the horizon azimuth (only lat + declination do);
  // _lng is accepted solely for call-site symmetry with solarTimes(lat, lng, date).
  const latRad = lat * rad;
  const { declRad } = eqTimeAndDecl(date);
  const ha = hourAngleDeg(-0.833, latRad, declRad);
  if (ha === null) return { sunriseAz: null, sunsetAz: null };
  const altRad = -0.833 * rad;
  const cosAz =
    (Math.sin(declRad) - Math.sin(altRad) * Math.sin(latRad)) /
    (Math.cos(altRad) * Math.cos(latRad));
  const az0 = Math.acos(Math.max(-1, Math.min(1, cosAz))) / rad; // 0..180, east side
  // 360 - az0 assumes the sun sets on the western half of the compass (valid for
  // the configured northern-mid-latitude origin; would need revisiting for
  // equatorial/southern origins).
  return { sunriseAz: az0, sunsetAz: 360 - az0 };
}
