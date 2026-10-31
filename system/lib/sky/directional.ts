import { canvasCover, canvasMean } from './clouds.ts';
import { SKY } from './constants.ts';
import type { SamplePoint, SkyContext, Verdict, Window } from './types.ts';

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const mean = (xs: number[], empty: number) =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : empty;
const angleDiff = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);

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
  // On-axis = the samples along the sun's bearing itself; the fan edges only
  // widen the mean. Fall back to the whole far field if a caller passed no
  // on-axis sample.
  const onAxisAll = farField.filter((s) => angleDiff(s.bearing, azimuth) <= 1);
  const onAxis = onAxisAll.length ? onAxisAll : farField;

  const axisLow = mean(
    onAxis.map((s) => s.layers.low),
    100,
  );
  const axisMid = mean(
    onAxis.map((s) => s.layers.mid),
    100,
  );
  const fanLow = mean(
    farField.map((s) => s.layers.low),
    100,
  );
  const nearLow = mean(
    nearField.map((s) => s.layers.low),
    0,
  );

  const horizonGap =
    axisLow < SKY.gapLowCloudMaxPct &&
    fanLow < SKY.fanLowCloudMaxPct &&
    axisMid < SKY.horizonMidCloudMaxPct;
  const bank = axisLow > SKY.bankLowCloudMinPct;
  const gapSample = horizonGap
    ? ([...onAxis].sort((a, b) => a.layers.low - b.layers.low)[0] ?? null)
    : null;

  const canvas = canvasMean(nearField.map((s) => s.layers));
  const canvasStrength = canvasCover({ low: 0, high: canvas.high, mid: canvas.mid });
  const [bandLo, bandHi] = SKY.canvasBandPct;
  const canvasInBand =
    canvasStrength >= bandLo && canvasStrength <= bandHi && canvas.mid <= SKY.canvasMidMaxPct;
  const overheadClear = nearLow <= SKY.overheadLowCloudMaxPct;

  let verdict: Verdict;
  if (horizonGap && canvasInBand && overheadClear) verdict = 'promising';
  else if (bank) verdict = 'blocked';
  else if (horizonGap && canvasStrength < SKY.canvasEmptyPct) verdict = 'clear';
  else verdict = 'mixed';

  // Confidence: lead-time × threshold-marginality. Marginality is the distance
  // to the NEAREST threshold that decided the verdict, so a read sitting on an
  // edge (gap at 14%, canvas at 31%) is reported as a coin flip, not a call.
  const leadConf = clamp01(1 - (Math.max(0, leadHours - 2) / 14) * 0.6); // 1 @2h → 0.4 @16h
  const gapMargin = Math.min(
    Math.abs(axisLow - SKY.gapLowCloudMaxPct),
    Math.abs(axisLow - SKY.bankLowCloudMinPct),
  );
  const canvasMargin = Math.min(
    Math.abs(canvasStrength - bandLo),
    Math.abs(canvasStrength - bandHi),
  );
  const lowMargin = Math.abs(nearLow - SKY.overheadLowCloudMaxPct);
  const marginConf = clamp01(0.6 + Math.min(gapMargin, canvasMargin, lowMargin) / 25); // edge cases → ~0.6
  const confidence = clamp01(leadConf * marginConf * (opts.coverage ?? 1) * (opts.agreement ?? 1));

  return {
    window,
    azimuth,
    horizonGap,
    gapBearing: gapSample ? gapSample.bearing : null,
    canvas,
    verdict,
    confidence,
    samples,
  };
}
