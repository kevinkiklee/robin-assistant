/**
 * What an auto-recall turn actually injected, and the outcome derived from it.
 *
 * recall() logs `outcome='answered'` whenever its candidate pool is non-empty — 99.6% of
 * rows — while only ~59% of qualifying prompts injected anything (Sep 2026), because the
 * composer filters, dedups and caps the pool afterwards. The composer therefore records
 * its kept set (`recall_log.kept_json`) on EVERY row it logs and overwrites the outcome
 * with one derived from it:
 *   - `injected` — at least one doc / snippet / correction / habit / open loop reached the turn
 *   - `filtered` — the pool had candidates but nothing survived the floors/dedup/caps
 *   - `miss`     — the pool was empty and nothing else injected
 */

export interface KeptSet {
  docs: string[];
  snippets: number[];
  corrections?: number[];
  habits: number;
  loops: number;
}

export type InjectionOutcome = 'injected' | 'filtered' | 'miss';

/** Items that reached the prompt. Tolerates partial/legacy shapes (missing fields → 0). */
export function keptCount(kept: Partial<KeptSet>): number {
  const len = (v: unknown) => (Array.isArray(v) ? v.length : 0);
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return (
    len(kept.docs) + len(kept.snippets) + len(kept.corrections) + num(kept.habits) + num(kept.loops)
  );
}

export function injectionOutcome(kept: Partial<KeptSet>, poolSize: number): InjectionOutcome {
  if (keptCount(kept) > 0) return 'injected';
  return poolSize > 0 ? 'filtered' : 'miss';
}

/** Parse a kept_json column; null for NULL/malformed. */
export function parseKept(json: string | null): Partial<KeptSet> | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as unknown;
    return v && typeof v === 'object' ? (v as Partial<KeptSet>) : null;
  } catch {
    return null;
  }
}
