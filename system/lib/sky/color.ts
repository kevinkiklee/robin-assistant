import type { Band, ColorRead, SkyContext } from './types.ts';

const POINTS = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
export function bearingLabel(deg: number): string {
  return POINTS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}

const BAND: Record<SkyContext['verdict'], Band> = {
  promising: 'promising', mixed: 'mixed', clear: 'plain', blocked: 'unlikely',
};

export function colorRead(ctx: SkyContext): ColorRead {
  const dir = bearingLabel(ctx.azimuth);
  const band = BAND[ctx.verdict];
  let why: string;
  let caution: string | null = null;

  if (band === 'promising') {
    why = `high cloud overhead + clear ${dir} horizon`;
  } else if (band === 'mixed') {
    why = ctx.horizonGap ? `some high cloud, partial ${dir} gap` : `thin cloud, ${dir} horizon uncertain`;
  } else if (band === 'plain') {
    why = `clear ${dir} horizon, low colour potential`;
  } else {
    why = `low-cloud bank toward the ${dir} sun`;
  }

  if (band === 'promising' || band === 'mixed') {
    if (!ctx.horizonGap) caution = `low cloud toward ${dir} may block the light`;
    else if (ctx.confidence < 0.5) caution = `forecast still uncertain`;
  }
  return { window: ctx.window, band, why, caution, confidence: ctx.confidence, azimuth: ctx.azimuth };
}
