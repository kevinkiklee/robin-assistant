import type { Clarity } from '../script/types.ts';

export interface Statement {
  label: string;
  value: string;
  confidence: number;
}

const W = '[a-z][a-z ]*?';
const V = '[a-z][a-z ]*';
const EXPLICIT = new RegExp(`Quick update on the (${W}): (${V})\\.`, 'g');
const HEDGED = new RegExp(`Still thinking about the (${W}), probably (${V})\\.`, 'g');
const REASSERT = new RegExp(`No, the (${W}) is (${V})\\. That is settled\\.`, 'g');
const CLAIM = new RegExp(`^The (${W}) is (${V})\\.$`);

export const stateSentence = (label: string, value: string, clarity: Clarity): string =>
  clarity === 'explicit'
    ? `Quick update on the ${label}: ${value}.`
    : clarity === 'hedged'
      ? `Still thinking about the ${label}, probably ${value}.`
      : `Spent some time on the ${label} today.`;
export const reassertSentence = (label: string, value: string): string =>
  `No, the ${label} is ${value}. That is settled.`;
export const claimSentence = (label: string, value: string): string => `The ${label} is ${value}.`;

/** Every grammar statement in free text (user turns, doc bodies, transcript chunks). */
export function parseStatements(text: string): Statement[] {
  const out: { at: number; s: Statement }[] = [];
  for (const [re, confidence] of [
    [EXPLICIT, 0.95],
    [HEDGED, 0.6],
    [REASSERT, 0.95],
  ] as const) {
    for (const m of text.matchAll(re)) {
      out.push({ at: m.index ?? 0, s: { label: m[1], value: m[2], confidence } });
    }
  }
  return out.sort((a, b) => a.at - b.at).map((x) => x.s);
}

/** The value a stored belief claim asserts, or null when it is not grammar output. */
export function parseClaim(claim: string): { label: string; value: string } | null {
  const m = CLAIM.exec(claim.trim());
  return m ? { label: m[1], value: m[2] } : null;
}

export function domainForLabel(
  label: string,
): 'travel' | 'creative' | 'preferences' | 'health' | null {
  if (label.endsWith(' trip')) return 'travel';
  if (label.endsWith(' gear')) return 'creative';
  if (label.endsWith(' pick')) return 'preferences';
  if (label.endsWith(' habit')) return 'health';
  return null;
}
