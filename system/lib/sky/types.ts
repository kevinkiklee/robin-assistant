export type Window = 'sunrise' | 'sunset';
export type Verdict = 'blocked' | 'clear' | 'mixed' | 'promising';
export type Band = 'unlikely' | 'plain' | 'mixed' | 'promising';

/** Cloud cover by altitude at one point/time. Percentages 0–100. */
export interface CloudLayers {
  low: number;
  mid: number;
  high: number;
}

/** One directional sample along the sun azimuth. */
export interface SamplePoint {
  distKm: number;
  bearing: number; // degrees from N
  lat: number;
  lng: number;
  layers: CloudLayers;
}

export interface SkyContext {
  window: Window;
  azimuth: number; // sun bearing at the horizon, degrees from N
  horizonGap: boolean;
  gapBearing: number | null;
  canvas: { high: number; mid: number }; // near-field mean %
  verdict: Verdict;
  confidence: number; // 0..1
  samples: SamplePoint[];
}

export interface ColorRead {
  window: Window;
  band: Band;
  why: string;
  caution: string | null;
  confidence: number;
  azimuth: number;
}

export type RecipeId = 'sunrise_color' | 'sunset_color' | 'fog_sunrise' | 'rain_clearing' | 'moon' | 'tide_window';

export interface RecipeMatch {
  recipe: RecipeId;
  window: Window;
  windowDate: string; // YYYY-MM-DD local
  title: string;
  body: string;
  key: string; // alert dedup key, e.g. "sunset:2026-06-25"
  mergeGroup: string; // recipes sharing this string merge into one notification
}

export interface Notification {
  title: string;
  message: string;
}
