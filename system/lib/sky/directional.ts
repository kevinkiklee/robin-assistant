import { canvasCover, canvasMean } from './clouds.ts';
import { SKY } from './constants.ts';
import type { SamplePoint, SkyContext, Verdict, Window } from './types.ts';

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

export function skyContext(opts: {
  window: Window;
  azimuth: number;
  samples: SamplePoint[];
  leadHours: number;
  coverage?: number;
  /** Ensemble agreement factor (0..1). 1 = full agreement / no spread signal. */
  agreement?: number;
}): SkyContext {
  const { window, azimuth, samples, leadHours } = opts;
  const farField = samples.filter((s) => s.distKm >= SKY.farFieldKm);
  const nearField = samples.filter((s) => s.distKm <= SKY.nearFieldKm);

  const minFarLow = farField.length ? Math.min(...farField.map((s) => s.layers.low)) : 100;
  const horizonGap = minFarLow < SKY.gapLowCloudMaxPct;
  const bank = minFarLow > SKY.bankLowCloudMinPct;
  const gapSample = farField.find((s) => s.layers.low === minFarLow) ?? null;

  const canvas = canvasMean(nearField.map((s) => s.layers));
  const canvasStrength = canvasCover({ low: 0, high: canvas.high, mid: canvas.mid });
  const [bandLo] = SKY.canvasBandPct;
  const canvasInBand = canvasStrength >= bandLo;

  let verdict: Verdict;
  if (horizonGap && canvasInBand) verdict = 'promising';
  else if (bank) verdict = 'blocked';
  else if (horizonGap && canvasStrength < SKY.canvasEmptyPct) verdict = 'clear';
  else verdict = 'mixed';

  // Confidence: lead-time × threshold-marginality.
  const leadConf = clamp01(1 - (Math.max(0, leadHours - 2) / 14) * 0.6); // 1 @2h → 0.4 @16h
  const gapMargin = Math.min(
    Math.abs(minFarLow - SKY.gapLowCloudMaxPct),
    Math.abs(minFarLow - SKY.bankLowCloudMinPct),
  );
  const canvasMargin = Math.abs(canvasStrength - bandLo);
  const marginConf = clamp01(0.6 + Math.min(gapMargin, canvasMargin) / 25); // edge cases → ~0.6
  const confidence = clamp01(leadConf * marginConf * (opts.coverage ?? 1) * (opts.agreement ?? 1));

  return {
    window,
    azimuth,
    horizonGap,
    gapBearing: horizonGap && gapSample ? gapSample.bearing : null,
    canvas,
    verdict,
    confidence,
    samples,
  };
}
