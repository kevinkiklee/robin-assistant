import type { Disclosure, Script } from './types.ts';

export interface Knowable {
  tier: 'explicit' | 'hedged' | 'none';
  acceptable: string[];
  superseded: string[];
}

/** Code-point string order: locale-independent, the same on every machine. */
export const cmpCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The stream item a rendered disclosure lives in, spelled like the renderer's item id
 * (`renderTemplate`), so ties on (day, minute) break exactly as the stream sorts.
 */
const streamKey = (d: Disclosure): string =>
  d.channel === 'doc' ? `doc:${d.id}` : `session:${d.sessionId ?? ''}`;

/**
 * Stream order of rendered disclosures: (day, minute, stream item id, disclosure id), all
 * code-point. The renderer orders a session's turns with this same comparator, so a
 * same-session same-slot pair is knowable in the order its turns are spoken.
 */
export const compareDisclosures = (a: Disclosure, b: Disclosure): number =>
  (a.day as number) - (b.day as number) ||
  a.minute - b.minute ||
  cmpCodePoint(streamKey(a), streamKey(b)) ||
  cmpCodePoint(a.id, b.id);

/** Rendered disclosures of a slot that count toward knowable, in stream order. */
export function renderedDisclosures(script: Script, slot: string): Disclosure[] {
  return script.disclosures
    .filter((d) => d.slot === slot && d.day !== null && d.clarity !== 'implied')
    .sort(compareDisclosures);
}

/**
 * What a perfect memory could know about `slot` at the END of sim-day `day`, or — with
 * `minute` — at that minute of `day` (disclosures at or before it count).
 */
export function knowable(script: Script, slot: string, day: number, minute?: number): Knowable {
  let explicit: string | null = null;
  let hedged: string | null = null;
  const seen: string[] = [];
  for (const d of renderedDisclosures(script, slot)) {
    if ((d.day as number) > day) break;
    if (minute !== undefined && d.day === day && d.minute > minute) break;
    if (d.clarity === 'explicit') {
      explicit = d.value;
      hedged = null;
      if (!seen.includes(d.value)) seen.push(d.value);
    } else {
      hedged = d.value;
    }
  }
  if (explicit === null && hedged === null) return { tier: 'none', acceptable: [], superseded: [] };
  const acceptable =
    hedged === null
      ? [explicit as string]
      : explicit === null
        ? [hedged]
        : [...new Set([explicit, hedged])];
  return {
    tier: hedged === null ? 'explicit' : 'hedged',
    acceptable,
    superseded: seen.filter((v) => !acceptable.includes(v)),
  };
}
