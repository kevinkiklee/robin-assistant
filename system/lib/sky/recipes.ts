// system/lib/sky/recipes.ts

import { bearingLabel } from './color.ts';
import { SKY } from './constants.ts';
import type { ColorRead, Notification, RecipeMatch, Window } from './types.ts';

const fmtTime = (d: Date) =>
  d
    .toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
    .toLowerCase()
    .replace(' ', '');

const inRange = (h: number | undefined, [lo, hi]: readonly [number, number]) =>
  h !== undefined && h >= lo && h <= hi;
const fmtMiles = (mi: number) => {
  const whole = Math.floor(mi);
  const frac = mi - whole;
  const f = frac >= 0.7 ? '¾' : frac >= 0.45 ? '½' : frac >= 0.2 ? '¼' : '';
  return `${whole || (f ? '' : '0')}${f} mi`.trim();
};
// Only a promising read with a confident forecast alerts. 'mixed' never fires:
// it used to at confidence ≥0.6 and produced the "horizon uncertain" pings
// that almost never delivered (2026-09-20).
const colourFires = (r: ColorRead) =>
  r.band === 'promising' && r.confidence >= SKY.alertMinConfidence;

const PRIORITY: Record<RecipeMatch['recipe'], number> = {
  sunset_color: 3,
  sunrise_color: 3,
  fog_night: 2,
  fog_on: 2,
  moon: 2,
  rain_clearing: 1,
  tide_window: 1,
};

export function matchRecipes(input: {
  sunrise?: ColorRead | null;
  sunset?: ColorRead | null;
  sunriseLeadH?: number;
  sunsetLeadH?: number;
  /** Tonight's fog composite after the TAF gate. */
  fog?: {
    index: number;
    peakWindow: string | null;
    /** The aerodrome TAF carries an FG/BR group over the night. Required. */
    tafConcurs: boolean;
    /** Peak window reaches the pre-dawn hour before sunrise. */
    preDawn: boolean;
  } | null;
  /** Latest observation from the configured TAF station, read on the pre-dawn ticks only. */
  metar?: {
    fogOn: boolean;
    mistForming: boolean;
    visibilityMi: number | null;
    /** ICAO id of the observing station, shown in the alert. */
    station?: string;
  } | null;
  rainClearing?: boolean;
  moon?: {
    illumination: number; // 0..1
    event: 'rise' | 'set';
    eventTime: Date;
    azimuth: number; // bearing of the moon event
    horizonClear: boolean; // directional read at the moon azimuth shows an open horizon
    phaseName: string;
    leadH: number;
    window: 'sunrise' | 'sunset'; // dawn moonset → 'sunrise'; dusk moonrise → 'sunset'
  } | null;
  tide?: { low: { time: Date; heightFt: number }; leadH: number } | null;
  dates: { sunrise: string; sunset: string };
}): RecipeMatch[] {
  const out: RecipeMatch[] = [];
  const mergeFor = (w: Window) => `${w}:${input.dates[w]}`;

  if (
    input.sunrise &&
    colourFires(input.sunrise) &&
    inRange(input.sunriseLeadH, SKY.sunriseLeadHours)
  ) {
    out.push({
      recipe: 'sunrise_color',
      window: 'sunrise',
      windowDate: input.dates.sunrise,
      title: '🌅 Sunrise may be colorful — worth an alarm',
      body: input.sunrise.why,
      key: mergeFor('sunrise'),
      mergeGroup: mergeFor('sunrise'),
    });
  }
  // Night-before fog: its own notification, not a footnote on the sunrise
  // one. The composite alone has never verified at ≥8/10 (per a correction), so
  // a TAF fog group is mandatory, not a bonus.
  const { fog } = input;
  if (
    fog &&
    fog.index >= SKY.fogAlertMinIndex &&
    fog.tafConcurs &&
    fog.preDawn &&
    inRange(input.sunriseLeadH, SKY.sunriseLeadHours)
  ) {
    out.push({
      recipe: 'fog_night',
      window: 'sunrise',
      windowDate: input.dates.sunrise,
      title: '🌫️ Fog likely before dawn — set an alarm',
      body: `fog index ${fog.index}/10${fog.peakWindow ? `, peak ${fog.peakWindow}` : ''} · TAF concurs`,
      key: `fog:${input.dates.sunrise}`,
      mergeGroup: `fog:${input.dates.sunrise}`,
    });
  }
  // Pre-dawn confirmation from the measured observation. Silent: it lands for
  // an early-morning check, it doesn't ring the phone.
  const { metar } = input;
  if (
    metar &&
    (metar.fogOn || metar.mistForming) &&
    inRange(input.sunriseLeadH, SKY.fogOnLeadHours)
  ) {
    const stage = metar.fogOn ? 'fog' : 'mist';
    const vis = metar.visibilityMi === null ? 'vis n/a' : `vis ${fmtMiles(metar.visibilityMi)}`;
    out.push({
      recipe: 'fog_on',
      window: 'sunrise',
      windowDate: input.dates.sunrise,
      title: metar.fogOn ? '🌫️ Fog is on now — go' : '🌫️ Mist forming — check again at the door',
      body: `${metar.station ?? 'METAR'} ${vis}`,
      key: `fog-on:${input.dates.sunrise}:${stage}`,
      mergeGroup: `fog-on:${input.dates.sunrise}`,
      silent: true,
    });
  }
  if (
    input.sunset &&
    colourFires(input.sunset) &&
    inRange(input.sunsetLeadH, SKY.sunsetLeadHours)
  ) {
    out.push({
      recipe: 'sunset_color',
      window: 'sunset',
      windowDate: input.dates.sunset,
      title: '🌇 Sunset may be colorful — head out',
      body: input.sunset.why,
      key: mergeFor('sunset'),
      mergeGroup: mergeFor('sunset'),
    });
  }
  if (input.rainClearing && inRange(input.sunsetLeadH, SKY.sunsetLeadHours)) {
    out.push({
      recipe: 'rain_clearing',
      window: 'sunset',
      windowDate: input.dates.sunset,
      title: '⛈️→☀️ Rain clearing into golden hour',
      body: 'storm breaking before sunset',
      key: `clearing:${input.dates.sunset}`,
      mergeGroup: mergeFor('sunset'),
    });
  }
  const { moon } = input;
  if (
    moon &&
    moon.illumination >= SKY.moonMinIllumination &&
    moon.horizonClear &&
    inRange(moon.leadH, moon.window === 'sunrise' ? SKY.sunriseLeadHours : SKY.sunsetLeadHours)
  ) {
    const windowDate = input.dates[moon.window];
    const az = Math.round(moon.azimuth);
    const phaseCapitalized = moon.phaseName.charAt(0).toUpperCase() + moon.phaseName.slice(1);
    const verb = moon.event === 'rise' ? 'rises' : 'sets';
    out.push({
      recipe: 'moon',
      window: moon.window,
      windowDate,
      title: `🌕 ${phaseCapitalized} moon ${verb} ${fmtTime(moon.eventTime)} (az ${az}° ${bearingLabel(moon.azimuth)}) — clear horizon`,
      body: `${moon.phaseName} moon${moon.event} at ${fmtTime(moon.eventTime)}, ${Math.round(moon.illumination * 100)}% illumination`,
      key: `moon:${windowDate}`,
      mergeGroup: mergeFor(moon.window),
    });
  }
  const { tide } = input;
  if (tide && inRange(tide.leadH, SKY.sunriseLeadHours)) {
    out.push({
      recipe: 'tide_window',
      window: 'sunrise',
      windowDate: input.dates.sunrise,
      title: `🌊 Low tide ${fmtTime(tide.low.time)} — exposed flats near sunrise`,
      body: `low tide ${tide.low.heightFt.toFixed(1)}ft at ${fmtTime(tide.low.time)}`,
      key: `tide:${input.dates.sunrise}`,
      mergeGroup: mergeFor('sunrise'),
    });
  }
  return out;
}

export function mergeMatches(matches: RecipeMatch[]): Notification[] {
  const groups = new Map<string, RecipeMatch[]>();
  for (const m of matches) {
    if (!groups.has(m.mergeGroup)) groups.set(m.mergeGroup, []);
    groups.get(m.mergeGroup)?.push(m);
  }
  const notes: Notification[] = [];
  for (const group of groups.values()) {
    const lead = [...group].sort((a, b) => PRIORITY[b.recipe] - PRIORITY[a.recipe])[0];
    notes.push({
      title: lead.title,
      message: group.map((g) => g.body).join(' · '),
      silent: group.every((g) => g.silent === true) || undefined,
    });
  }
  return notes;
}
