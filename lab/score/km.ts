// lab/score/km.ts
export interface KMSummary {
  n: number;
  events: number;
  censored: number;
  median: number | null;
  survivalAt: Record<string, number>;
}

/** Product-limit estimator. Ties: events before censorings at the same time. */
export function kaplanMeier(
  obs: { time: number; event: boolean }[],
  at: readonly number[] = [1, 7, 30],
): KMSummary {
  const sorted = [...obs].sort((a, b) => a.time - b.time || Number(b.event) - Number(a.event));
  const steps: { time: number; s: number }[] = [];
  let atRisk = sorted.length;
  let s = 1;
  let i = 0;
  while (i < sorted.length) {
    const t = sorted[i].time;
    let d = 0;
    let c = 0;
    while (i < sorted.length && sorted[i].time === t) {
      if (sorted[i].event) d++;
      else c++;
      i++;
    }
    if (d > 0) {
      s *= 1 - d / atRisk;
      steps.push({ time: t, s });
    }
    atRisk -= d + c;
  }
  const S = (t: number) => steps.filter((x) => x.time <= t).at(-1)?.s ?? 1;
  const median = steps.find((x) => x.s <= 0.5)?.time ?? null;
  const events = obs.filter((o) => o.event).length;
  return {
    n: obs.length,
    events,
    censored: obs.length - events,
    median,
    survivalAt: Object.fromEntries(at.map((t) => [String(t), S(t)])),
  };
}
