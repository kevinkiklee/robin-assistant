// lab/score/metrics.ts
//
// State-layer metrics: compare a copy's head timeline with what a perfect memory
// could know at the end of each sim-day.
//
// Known blind spot (plan-mandated): a record asserting a value before the slot has any
// explicit/hedged disclosure (knowable tier 'none') is never judged wrong, so
// pre-disclosure fabrications are invisible to the route and staleness metrics.
import { dayStartMs } from '../copy/day.ts';
import { knowable, renderedDisclosures } from '../script/truth.ts';
import type { ProbeKind, Script } from '../script/types.ts';
import { type KMSummary, kaplanMeier } from './km.ts';
import { assertedAt, type HeadRecord, headsAt } from './timeline.ts';

export interface StateMetrics {
  horizonDay: number;
  /** Distinct non-retracted records ever written (current heads are in bloat). */
  records: number;
  /** Final day. */
  staleness: number | null;
  /** Mean over days 6, 13, 20, … */
  stalenessMean: number | null;
  /** Share of slots knowable at tier explicit on the final day that assert ≥ 1 value. */
  coverage: number | null;
  resurrections: number;
  latency: KMSummary;
  /** Phantom current heads at the horizon per 100 current heads; null with no heads. */
  phantomPer100: number | null;
  /** Non-retracted phantom records ever written. */
  phantomRecordsEver: number;
  offCatalogHeads: number;
  /** Share of historical-probe values that some record ever asserted (append-only: no pruning signal). */
  historicalEverHeld: number | null;
  abstentionViolations: number;
  probeAccuracy: Partial<Record<ProbeKind, { correct: number; total: number }>>;
  routes: Record<string, { heads: number; wrong: number }>;
}

const DAY_MS = 86_400_000;
const MIN_MS = 60_000;
const ROUTES: readonly HeadRecord['route'][] = [
  'direct-believe',
  'correction-believe',
  'promotion',
  'other',
];

export type LatencyObs = { slot: string; day: number; time: number; event: boolean };

/**
 * Latency observations: days from an explicit state change to the slot asserting exactly
 * that value. Censored at the last day observed — the day before a newer explicit value
 * arrives, or the final day.
 */
export function latencyObservations(
  script: Script,
  at: (day: number, slot: string) => Set<string>,
  H: number,
): LatencyObs[] {
  const obs: LatencyObs[] = [];
  for (const s of script.slots) {
    const explicit = renderedDisclosures(script, s.key).filter((d) => d.clarity === 'explicit');
    let prev: string | null = null;
    explicit.forEach((d, i) => {
      const day = d.day as number;
      if (d.kind === 'state' && d.value !== prev && day < H) {
        const next = explicit.slice(i + 1).find((x) => x.value !== d.value);
        const until = Math.min(next ? (next.day as number) : H, H);
        let fixed: number | null = null;
        for (let t = day; t < until; t++) {
          const a = at(t, s.key);
          if (a.size === 1 && a.has(d.value)) {
            fixed = t;
            break;
          }
        }
        const push = (time: number, event: boolean) => obs.push({ slot: s.key, day, time, event });
        if (fixed !== null) push(fixed - day, true);
        else if (next && (next.day as number) < H)
          push(Math.max(0, (next.day as number) - 1 - day), false);
        else push(H - 1 - day, false);
      }
      prev = d.value;
    });
  }
  return obs;
}

export function scoreTimeline(
  script: Script,
  records: HeadRecord[],
  startDate: string,
  horizonDay: number,
): StateMetrics {
  const H = horizonDay;
  const endOfDay = (d: number) => dayStartMs(startDate, d) + DAY_MS - 1;
  const dayOf = (tsMs: number) => Math.floor((tsMs - dayStartMs(startDate, 0)) / DAY_MS);
  const minuteOf = (tsMs: number, day: number) =>
    Math.floor((tsMs - dayStartMs(startDate, day)) / MIN_MS);
  const slotByKey = new Map(script.slots.map((s) => [s.key, s]));
  const EMPTY = new Set<string>();

  // Asserted values per slot at the end of every day.
  const asserted: Map<string, Set<string>>[] = [];
  for (let d = 0; d < H; d++) asserted.push(assertedAt(records, endOfDay(d)));
  const at = (d: number, slot: string) => asserted[d].get(slot) ?? EMPTY;

  // Phantoms and off-catalog records (non-retracted only: a retraction asserts nothing).
  const live = records.filter((r) => !r.retracted);
  const offCatalog = (r: HeadRecord) =>
    r.slot === null ||
    r.value === null ||
    !(slotByKey.get(r.slot)?.values.includes(r.value) ?? false);
  // Bait gear is never bought: 'owned' is a phantom whether or not a never-true probe exists.
  const phantom = (r: HeadRecord) =>
    offCatalog(r) || (slotByKey.get(r.slot as string)?.bait === true && r.value === 'owned');
  const offCatalogHeads = live.filter(offCatalog).length;
  const finalHeads = H > 0 ? headsAt(records, endOfDay(H - 1)) : [];

  // Staleness.
  const staleness = (d: number): number | null => {
    let n = 0;
    let stale = 0;
    for (const s of script.slots) {
      const k = knowable(script, s.key, d);
      const a = at(d, s.key);
      if (k.tier === 'none' || a.size === 0) continue;
      n++;
      if ([...a].some((v) => k.superseded.includes(v))) stale++;
    }
    return n === 0 ? null : stale / n;
  };
  const weekly: number[] = [];
  for (let d = 6; d < H; d += 7) {
    const v = staleness(d);
    if (v !== null) weekly.push(v);
  }

  // Coverage: of the slots a perfect memory knows explicitly at the horizon, how many assert anything.
  let coverage: number | null = null;
  if (H > 0) {
    const known = script.slots.filter((s) => knowable(script, s.key, H - 1).tier === 'explicit');
    if (known.length > 0)
      coverage = known.filter((s) => at(H - 1, s.key).size > 0).length / known.length;
  }

  // Resurrections: a value already dead while the slot was right comes back.
  let resurrections = 0;
  for (const s of script.slots) {
    let R: string[] = [];
    let counted = false;
    for (let d = 0; d < H; d++) {
      const k = knowable(script, s.key, d);
      const a = at(d, s.key);
      if (a.size > 0 && [...a].every((v) => k.acceptable.includes(v))) {
        R = k.superseded;
        counted = false;
      } else if (!counted && [...a].some((v) => R.includes(v))) {
        resurrections++;
        counted = true;
      }
    }
  }

  const obs = latencyObservations(script, at, H);

  // Probes.
  const probeAccuracy: StateMetrics['probeAccuracy'] = {};
  let abstentionViolations = 0;
  let histHit = 0;
  let histTotal = 0;
  for (const p of script.probes) {
    if (p.day >= H) continue;
    const a = at(p.day, p.slot);
    let ok: boolean;
    switch (p.kind) {
      case 'current':
      case 'corrected':
      case 'superseded':
        ok =
          a.size > 0 &&
          [...a].every((v) => p.acceptable.includes(v)) &&
          !p.forbidden.some((v) => a.has(v));
        break;
      case 'never-true':
        ok = !p.forbidden.some((v) => a.has(v));
        break;
      case 'abstain':
        ok = a.size === 0;
        if (!ok) abstentionViolations++;
        break;
      case 'historical': {
        const history = new Set(
          records
            .filter((r) => r.slot === p.slot && r.value !== null && r.tsMs <= endOfDay(p.day))
            .map((r) => r.value as string),
        );
        const hit = p.acceptable.filter((v) => history.has(v)).length;
        histHit += hit;
        histTotal += p.acceptable.length;
        ok = hit === p.acceptable.length;
        break;
      }
    }
    const acc = probeAccuracy[p.kind] ?? { correct: 0, total: 0 };
    probeAccuracy[p.kind] = acc;
    acc.total++;
    if (ok) acc.correct++;
  }

  // Route attribution: is each record wrong at its own (day, minute)?
  const routes: StateMetrics['routes'] = Object.fromEntries(
    ROUTES.map((r) => [r, { heads: 0, wrong: 0 }]),
  );
  for (const r of live) {
    const row = routes[r.route];
    row.heads++;
    let wrong = phantom(r);
    if (!wrong) {
      const day = dayOf(r.tsMs);
      const k = knowable(script, r.slot as string, day, minuteOf(r.tsMs, day));
      wrong = k.tier !== 'none' && !k.acceptable.includes(r.value as string);
    }
    if (wrong) row.wrong++;
  }

  return {
    horizonDay: H,
    records: live.length,
    staleness: H > 0 ? staleness(H - 1) : null,
    stalenessMean: weekly.length ? weekly.reduce((x, y) => x + y, 0) / weekly.length : null,
    coverage,
    resurrections,
    latency: kaplanMeier(obs),
    phantomPer100: finalHeads.length
      ? (finalHeads.filter(phantom).length * 100) / finalHeads.length
      : null,
    phantomRecordsEver: live.filter(phantom).length,
    offCatalogHeads,
    historicalEverHeld: histTotal ? histHit / histTotal : null,
    abstentionViolations,
    probeAccuracy,
    routes,
  };
}
