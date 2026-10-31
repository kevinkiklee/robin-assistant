import { mulberry32 } from './rng.ts';
import { cmpCodePoint, knowable, renderedDisclosures } from './truth.ts';
import type { Probe, Script } from './types.ts';

export const LATENCY_OFFSETS: readonly number[] = [1, 7, 30, 90];
/** Slots sampled for the monthly current-state probe. */
export const MONTHLY_SAMPLE = 5;
/** Salt so the monthly sample's stream is independent of the generator's. */
const MONTHLY_SALT = 0x5eed_b0b5;

export function generateProbes(script: Script): Probe[] {
  const H = script.horizonDays;
  const out: Probe[] = [];
  const order = new Map<string, number>();
  const byKey = new Map<string, Probe>();
  let n = 0;
  const label = (key: string) => script.slots.find((s) => s.key === key)?.label ?? key;
  // One probe per (slot, day, kind): a repeat merges its forbidden values into the first.
  // `acceptable` is knowable(slot, day) for every kind that can repeat, so it is identical.
  const push = (p: Omit<Probe, 'id' | 'question'>) => {
    const key = `${p.slot}\u0000${p.day}\u0000${p.kind}`;
    const prior = byKey.get(key);
    if (prior) {
      for (const v of p.forbidden) if (!prior.forbidden.includes(v)) prior.forbidden.push(v);
      return;
    }
    const probe: Probe = {
      ...p,
      forbidden: [...p.forbidden],
      id: `p${n}`,
      question: `What is the state of the ${label(p.slot)}?`,
    };
    order.set(probe.id, n++);
    byKey.set(key, probe);
    out.push(probe);
  };

  for (const slot of script.slots) {
    const ds = renderedDisclosures(script, slot.key);
    let prevExplicit: string | null = null;
    for (const d of ds) {
      if (d.clarity !== 'explicit') continue;
      const day = d.day as number;
      if (d.kind === 'reassert') {
        for (const o of LATENCY_OFFSETS) {
          if (day + o < H)
            push({
              day: day + o,
              kind: 'corrected',
              slot: slot.key,
              acceptable: knowable(script, slot.key, day + o).acceptable,
              forbidden: [],
            });
        }
      } else if (d.value !== prevExplicit) {
        for (const o of LATENCY_OFFSETS) {
          if (day + o >= H) continue;
          const k = knowable(script, slot.key, day + o);
          push({
            day: day + o,
            kind: 'current',
            slot: slot.key,
            acceptable: k.acceptable,
            forbidden: [],
          });
          if (prevExplicit !== null && !k.acceptable.includes(prevExplicit)) {
            push({
              day: day + o,
              kind: 'superseded',
              slot: slot.key,
              acceptable: k.acceptable,
              forbidden: [prevExplicit],
            });
          }
        }
      }
      prevExplicit = d.value;
    }
    if (slot.bait) {
      const from = script.facts.find((f) => f.slot === slot.key)?.validFrom ?? 0;
      for (let day = from + 30; day < H; day += 30) {
        push({ day, kind: 'never-true', slot: slot.key, acceptable: [], forbidden: ['owned'] });
      }
    }
    const past = [...new Set(ds.filter((d) => d.clarity === 'explicit').map((d) => d.value))];
    if (past.length >= 2)
      push({ day: H - 1, kind: 'historical', slot: slot.key, acceptable: past, forbidden: [] });
    if (ds.length === 0 && !script.disclosures.some((d) => d.slot === slot.key && d.day !== null)) {
      push({ day: H - 1, kind: 'abstain', slot: slot.key, acceptable: [], forbidden: [] });
    }
  }
  // Monthly current-state sample, drawn with an RNG seeded from the script.
  const r = mulberry32((script.seed ^ MONTHLY_SALT) >>> 0);
  for (let day = 29; day < H; day += 30) {
    const ready = script.slots
      .map((s) => s.key)
      .sort(cmpCodePoint)
      .filter((k) => knowable(script, k, day).tier === 'explicit');
    for (let i = ready.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [ready[i], ready[j]] = [ready[j], ready[i]];
    }
    for (const k of ready.slice(0, MONTHLY_SAMPLE))
      push({
        day,
        kind: 'current',
        slot: k,
        acceptable: knowable(script, k, day).acceptable,
        forbidden: [],
      });
  }
  // Creation order breaks day ties: numeric, not locale- or code-point-dependent.
  return out.sort(
    (a, b) => a.day - b.day || (order.get(a.id) as number) - (order.get(b.id) as number),
  );
}
