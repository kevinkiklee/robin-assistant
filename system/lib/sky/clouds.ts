import { SKY } from './constants.ts';
import type { CloudLayers } from './types.ts';

export function canvasCover(layers: CloudLayers): number {
  return Math.min(100, layers.high + layers.mid * SKY.canvasMidWeight);
}

export function canvasMean(samples: CloudLayers[]): { high: number; mid: number } {
  if (samples.length === 0) return { high: 0, mid: 0 };
  const sum = samples.reduce((a, s) => ({ high: a.high + s.high, mid: a.mid + s.mid }), {
    high: 0,
    mid: 0,
  });
  return { high: sum.high / samples.length, mid: sum.mid / samples.length };
}
