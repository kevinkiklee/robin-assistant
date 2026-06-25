// Pure lunar-ephemeris module — no network, no I/O.
//
// Low-precision moon position follows Meeus, "Astronomical Algorithms" (2nd ed.):
//   - geocentric ecliptic longitude/latitude/distance from the principal
//     periodic terms (ch. 47, abridged set),
//   - obliquity + nutation-free conversion to equatorial coordinates (ch. 13),
//   - local hour angle → altitude/azimuth (ch. 13),
//   - rise/set by scanning altitude crossings of the apparent horizon
//     (standard −0.566° refraction minus the moon's horizontal parallax),
//   - illuminated fraction from the sun–moon elongation / phase angle (ch. 48).
//
// Accuracy target: rise/set within a few minutes, azimuth within a degree or
// two, illumination within ~1%. This mirrors the style of `solar.ts`.

export interface MoonInfo {
  rise: Date | null; // next moonrise on the local date, or null if none
  set: Date | null; // next moonset, or null
  riseAz: number | null; // compass bearing (deg from N) at moonrise
  setAz: number | null; // bearing at moonset
  illumination: number; // 0..1 fraction lit
  phaseName: string; // 'new' | 'waxing crescent' | 'first quarter' | 'waxing gibbous' | 'full' | 'waning gibbous' | 'last quarter' | 'waning crescent'
}

const rad = Math.PI / 180;

/** Normalize degrees to [0, 360). */
function norm360(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/** Julian Day (including fractional day) for a Date's UTC instant. */
function julianDay(date: Date): number {
  return date.getTime() / 86400000 + 2440587.5;
}

/** Julian centuries from J2000.0 (TT≈UT at this precision). */
function julianCenturies(jd: number): number {
  return (jd - 2451545) / 36525;
}

interface EclipticPos {
  lonDeg: number; // apparent geocentric ecliptic longitude
  latDeg: number; // geocentric ecliptic latitude
  distKm: number; // distance Earth→Moon (km)
}

/**
 * Geocentric ecliptic position of the Moon (Meeus ch. 47, abridged).
 * Keeps the dominant longitude/latitude/distance terms — enough for a few
 * arcminutes of longitude, which is well within our minute/degree budget.
 */
function moonEcliptic(T: number): EclipticPos {
  // Mean elements (degrees).
  const Lp = 218.3164477 + 481267.88123421 * T - 0.0015786 * T * T; // mean longitude
  const D = 297.8501921 + 445267.1114034 * T - 0.0018819 * T * T; // mean elongation
  const M = 357.5291092 + 35999.0502909 * T; // sun's mean anomaly
  const Mp = 134.9633964 + 477198.8675055 * T + 0.0087414 * T * T; // moon's mean anomaly
  const F = 93.272095 + 483202.0175233 * T - 0.0036539 * T * T; // argument of latitude

  const Drad = D * rad;
  const Mrad = M * rad;
  const Mprad = Mp * rad;
  const Frad = F * rad;

  // Longitude (deg) — leading periodic terms (coeffs in degrees).
  const lon =
    Lp +
    6.288774 * Math.sin(Mprad) +
    1.274027 * Math.sin(2 * Drad - Mprad) +
    0.658314 * Math.sin(2 * Drad) +
    0.213618 * Math.sin(2 * Mprad) -
    0.185116 * Math.sin(Mrad) -
    0.114332 * Math.sin(2 * Frad) +
    0.058793 * Math.sin(2 * Drad - 2 * Mprad) +
    0.057066 * Math.sin(2 * Drad - Mrad - Mprad) +
    0.053322 * Math.sin(2 * Drad + Mprad) +
    0.045758 * Math.sin(2 * Drad - Mrad) -
    0.040923 * Math.sin(Mrad - Mprad) -
    0.03472 * Math.sin(Drad) -
    0.030383 * Math.sin(Mrad + Mprad) +
    0.015327 * Math.sin(2 * Drad - 2 * Frad) -
    0.012528 * Math.sin(2 * Frad + Mprad) +
    0.01098 * Math.sin(2 * Frad - Mprad) +
    0.010675 * Math.sin(4 * Drad - Mprad) +
    0.010034 * Math.sin(3 * Mprad);

  // Latitude (deg) — leading periodic terms.
  const lat =
    5.128122 * Math.sin(Frad) +
    0.280602 * Math.sin(Mprad + Frad) +
    0.277693 * Math.sin(Mprad - Frad) +
    0.173237 * Math.sin(2 * Drad - Frad) +
    0.055413 * Math.sin(2 * Drad - Mprad + Frad) +
    0.046271 * Math.sin(2 * Drad - Mprad - Frad) +
    0.032573 * Math.sin(2 * Drad + Frad) +
    0.017198 * Math.sin(2 * Mprad + Frad) +
    0.009266 * Math.sin(2 * Drad + Mprad - Frad) +
    0.008822 * Math.sin(2 * Mprad - Frad) +
    0.008216 * Math.sin(2 * Drad - Mrad - Frad) +
    0.004324 * Math.sin(2 * Drad - 2 * Mprad - Frad) +
    0.0042 * Math.sin(2 * Drad + Mprad + Frad);

  // Distance (km) — Earth→Moon, leading terms (coeffs already in km).
  const dist =
    385000.56 +
    (-20905.355 * Math.cos(Mprad) -
      3699.111 * Math.cos(2 * Drad - Mprad) -
      2955.968 * Math.cos(2 * Drad) -
      569.925 * Math.cos(2 * Mprad) +
      48.888 * Math.cos(Mrad) -
      3.149 * Math.cos(2 * Frad) +
      246.158 * Math.cos(2 * Drad - 2 * Mprad) -
      152.138 * Math.cos(2 * Drad - Mrad - Mprad) -
      170.733 * Math.cos(2 * Drad + Mprad) -
      204.586 * Math.cos(2 * Drad - Mrad) -
      129.62 * Math.cos(Mrad - Mprad) +
      108.743 * Math.cos(Drad) +
      104.755 * Math.cos(Mrad + Mprad) +
      79.661 * Math.cos(2 * Frad - Mprad)); // km

  return { lonDeg: norm360(lon), latDeg: lat, distKm: dist };
}

/** Sun's geometric ecliptic longitude (deg), low precision (Meeus ch. 25). */
function sunLongitude(T: number): number {
  const L0 = 280.46646 + 36000.76983 * T + 0.0003032 * T * T;
  const M = 357.52911 + 35999.05029 * T - 0.0001537 * T * T;
  const Mrad = M * rad;
  const C =
    (1.914602 - 0.004817 * T - 0.000014 * T * T) * Math.sin(Mrad) +
    (0.019993 - 0.000101 * T) * Math.sin(2 * Mrad) +
    0.000289 * Math.sin(3 * Mrad);
  return norm360(L0 + C);
}

/** Mean obliquity of the ecliptic (deg), Meeus ch. 22. */
function obliquity(T: number): number {
  return 23.439291 - 0.0130042 * T - 1.64e-7 * T * T + 5.04e-7 * T * T * T;
}

interface Equatorial {
  raDeg: number; // right ascension (deg)
  decDeg: number; // declination (deg)
}

/** Ecliptic (lon, lat) → equatorial (RA, Dec), all in degrees. */
function eclipticToEquatorial(lonDeg: number, latDeg: number, epsDeg: number): Equatorial {
  const lon = lonDeg * rad;
  const lat = latDeg * rad;
  const eps = epsDeg * rad;
  const sinDec = Math.sin(lat) * Math.cos(eps) + Math.cos(lat) * Math.sin(eps) * Math.sin(lon);
  const dec = Math.asin(Math.max(-1, Math.min(1, sinDec)));
  const y = Math.sin(lon) * Math.cos(eps) - Math.tan(lat) * Math.sin(eps);
  const x = Math.cos(lon);
  const ra = Math.atan2(y, x);
  return { raDeg: norm360(ra / rad), decDeg: dec / rad };
}

/** Greenwich mean sidereal time (deg) at a given JD (Meeus ch. 12). */
function gmstDeg(jd: number): number {
  const T = julianCenturies(jd);
  const theta =
    280.46061837 +
    360.98564736629 * (jd - 2451545) +
    0.000387933 * T * T -
    (T * T * T) / 38710000;
  return norm360(theta);
}

interface AltAz {
  altDeg: number; // geometric altitude (no refraction applied)
  azDeg: number; // compass bearing from North, clockwise [0,360)
}

/** Moon topocentric-ish altitude/azimuth at a UTC instant + observer. */
function moonAltAz(date: Date, latRad: number, lngDeg: number): AltAz & { parallaxDeg: number } {
  const jd = julianDay(date);
  const T = julianCenturies(jd);
  const ecl = moonEcliptic(T);
  const eps = obliquity(T);
  const { raDeg, decDeg } = eclipticToEquatorial(ecl.lonDeg, ecl.latDeg, eps);

  // Local hour angle (deg): H = GMST + observer-longitude − RA.
  // lngDeg is east-positive.
  const H = norm360(gmstDeg(jd) + lngDeg - raDeg);
  const Hrad = H * rad;
  const decRad = decDeg * rad;

  const sinAlt =
    Math.sin(latRad) * Math.sin(decRad) + Math.cos(latRad) * Math.cos(decRad) * Math.cos(Hrad);
  const altDeg = Math.asin(Math.max(-1, Math.min(1, sinAlt))) / rad;

  // Azimuth measured from North, clockwise.
  const y = Math.sin(Hrad);
  const x = Math.cos(Hrad) * Math.sin(latRad) - Math.tan(decRad) * Math.cos(latRad);
  const azDeg = norm360(Math.atan2(y, x) / rad + 180);

  // Horizontal parallax (deg) from distance: sin(π) = 6378.14 / d.
  const parallaxDeg = Math.asin(6378.14 / ecl.distKm) / rad;

  return { altDeg, azDeg, parallaxDeg };
}

/** Sun–moon elongation → illuminated fraction (Meeus ch. 48), at a UTC instant. */
function moonIllumination(date: Date): number {
  const jd = julianDay(date);
  const T = julianCenturies(jd);
  const ecl = moonEcliptic(T);
  const eps = obliquity(T);
  const moonEq = eclipticToEquatorial(ecl.lonDeg, ecl.latDeg, eps);
  const sunLon = sunLongitude(T);
  const sunEq = eclipticToEquatorial(sunLon, 0, eps);

  const ra0 = sunEq.raDeg * rad;
  const dec0 = sunEq.decDeg * rad;
  const ra = moonEq.raDeg * rad;
  const dec = moonEq.decDeg * rad;

  // Geocentric elongation ψ between Sun and Moon.
  const cosPsi =
    Math.sin(dec0) * Math.sin(dec) + Math.cos(dec0) * Math.cos(dec) * Math.cos(ra0 - ra);
  const psi = Math.acos(Math.max(-1, Math.min(1, cosPsi)));

  // Phase angle i of the Moon (Sun is ~389× farther, so this approximation holds).
  const sunDistKm = 149598000; // 1 AU
  const i = Math.atan2(sunDistKm * Math.sin(psi), ecl.distKm - sunDistKm * Math.cos(psi));
  return (1 + Math.cos(i)) / 2;
}

/**
 * Signed phase angle for naming: difference between Moon's and Sun's ecliptic
 * longitude, in [0,360). 0=new, 90=first quarter, 180=full, 270=last quarter.
 */
function phaseLongitudeDeg(date: Date): number {
  const T = julianCenturies(julianDay(date));
  return norm360(moonEcliptic(T).lonDeg - sunLongitude(T));
}

function phaseNameFromAngle(angleDeg: number): string {
  // 8 bins centered on the cardinal phases (each principal phase gets a ±~22.5° window).
  const a = norm360(angleDeg);
  if (a < 22.5 || a >= 337.5) return 'new';
  if (a < 67.5) return 'waxing crescent';
  if (a < 112.5) return 'first quarter';
  if (a < 157.5) return 'waxing gibbous';
  if (a < 202.5) return 'full';
  if (a < 247.5) return 'waning gibbous';
  if (a < 292.5) return 'last quarter';
  return 'waning crescent';
}

/**
 * Scan the local day in fine steps, find the first up-crossing (rise) and the
 * first down-crossing (set) of the apparent horizon, refining each by bisection.
 *
 * The apparent-horizon altitude is −(refraction + semidiameter) + parallax.
 * We use the standard atmospheric refraction at the horizon (34′ = 0.5667°)
 * plus the moon's mean semidiameter (~0.259°), offset by horizontal parallax
 * (~0.95°), giving a target altitude near +0.125° as the prompt notes.
 */
function findRiseSet(
  lat: number,
  lngDeg: number,
  dayStartUtcMs: number,
): { rise: Date | null; set: Date | null; riseAz: number | null; setAz: number | null } {
  const latRad = lat * rad;

  // Target geometric altitude of the moon's center at the apparent horizon.
  const targetAlt = (date: Date): number => {
    const { parallaxDeg } = moonAltAz(date, latRad, lngDeg);
    const refraction = 0.5667; // standard horizon refraction (34 arcmin)
    const semidiameter = 0.2725; // mean angular radius of the Moon (≈ parallax/3.67)
    return parallaxDeg - refraction - semidiameter;
  };

  const altMinusTarget = (ms: number): number => {
    const d = new Date(ms);
    return moonAltAz(d, latRad, lngDeg).altDeg - targetAlt(d);
  };

  const stepMin = 10;
  const stepMs = stepMin * 60000;
  const spanMs = 24 * 60 * 60000;

  let rise: Date | null = null;
  let set: Date | null = null;

  let prevMs = dayStartUtcMs;
  let prevVal = altMinusTarget(prevMs);

  for (let ms = dayStartUtcMs + stepMs; ms <= dayStartUtcMs + spanMs; ms += stepMs) {
    const val = altMinusTarget(ms);
    if (prevVal <= 0 && val > 0 && rise === null) {
      rise = new Date(refineCrossing(altMinusTarget, prevMs, ms));
    } else if (prevVal >= 0 && val < 0 && set === null) {
      set = new Date(refineCrossing(altMinusTarget, prevMs, ms));
    }
    if (rise !== null && set !== null) break;
    prevMs = ms;
    prevVal = val;
  }

  const azAt = (d: Date | null): number | null =>
    d === null ? null : norm360(moonAltAz(d, latRad, lngDeg).azDeg);

  return { rise, set, riseAz: azAt(rise), setAz: azAt(set) };
}

/** Bisection on the sign change of f between [aMs, bMs] (f(a) and f(b) differ in sign). */
function refineCrossing(f: (ms: number) => number, aMs: number, bMs: number): number {
  let lo = aMs;
  let hi = bMs;
  let flo = f(lo);
  for (let k = 0; k < 40; k++) {
    const mid = (lo + hi) / 2;
    const fmid = f(mid);
    if (Math.abs(fmid) < 1e-4 || hi - lo < 1000) return mid;
    if (Math.sign(fmid) === Math.sign(flo)) {
      lo = mid;
      flo = fmid;
    } else {
      hi = mid;
    }
  }
  return (lo + hi) / 2;
}

/**
 * Moon rise/set, horizon bearings, illumination and phase name for the local
 * calendar date at the given coordinates. `date` selects the local day; the
 * scan runs over that day's local-midnight-to-midnight window.
 *
 * Local midnight is derived from the supplied Date's local-time components, so
 * the host process timezone defines "the local date" (matching how `solar.ts`
 * treats the calendar day via UTC date fields for an already-localized input).
 */
export function moonInfo(lat: number, lng: number, date: Date): MoonInfo {
  // Local-midnight of `date` in the host timezone.
  const localMidnight = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
  const dayStartUtcMs = localMidnight.getTime();

  const { rise, set, riseAz, setAz } = findRiseSet(lat, lng, dayStartUtcMs);

  // Illumination + phase evaluated at local noon (a stable representative
  // instant; the value changes <1.5% across a day).
  const noon = new Date(dayStartUtcMs + 12 * 60 * 60000);
  const illumination = moonIllumination(noon);
  const phaseName = phaseNameFromAngle(phaseLongitudeDeg(noon));

  return { rise, set, riseAz, setAz, illumination, phaseName };
}
