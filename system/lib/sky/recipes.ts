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
const colourFires = (r: ColorRead) =>
  r.band === 'promising' || (r.band === 'mixed' && r.confidence >= 0.6);

const PRIORITY: Record<RecipeMatch['recipe'], number> = {
  sunset_color: 3,
  sunrise_color: 3,
  fog_sunrise: 2,
  moon: 2,
  rain_clearing: 1,
  tide_window: 1,
};

export function matchRecipes(input: {
  sunrise?: ColorRead | null;
  sunset?: ColorRead | null;
  sunriseLeadH?: number;
  sunsetLeadH?: number;
  fogIndex?: number;
  fogCoversSunrise?: boolean;
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
  if (
    input.fogIndex !== undefined &&
    input.fogIndex >= SKY.fogAlertMinIndex &&
    input.fogCoversSunrise &&
    inRange(input.sunriseLeadH, SKY.sunriseLeadHours)
  ) {
    out.push({
      recipe: 'fog_sunrise',
      window: 'sunrise',
      windowDate: input.dates.sunrise,
      title: '🌫️ River fog near sunrise',
      body: `fog index ${input.fogIndex}/10`,
      key: `fog:${input.dates.sunrise}`,
      mergeGroup: mergeFor('sunrise'),
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
    groups.get(m.mergeGroup)!.push(m);
  }
  const notes: Notification[] = [];
  for (const group of groups.values()) {
    const lead = [...group].sort((a, b) => PRIORITY[b.recipe] - PRIORITY[a.recipe])[0];
    notes.push({ title: lead.title, message: group.map((g) => g.body).join(' · ') });
  }
  return notes;
}
