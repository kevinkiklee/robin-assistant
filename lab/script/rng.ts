export type Rng = () => number;

/** Small, fast, seedable PRNG. Same seed → same sequence on every platform. */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const int = (r: Rng, lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1));
export const pick = <T>(r: Rng, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
export const chance = (r: Rng, p: number): boolean => r() < p;
export function weighted<T extends string>(r: Rng, w: Record<T, number>): T {
  const entries = Object.entries(w) as [T, number][];
  const total = entries.reduce((s, [, v]) => s + v, 0);
  let x = r() * total;
  for (const [k, v] of entries) {
    x -= v;
    if (x < 0) return k;
  }
  return entries[entries.length - 1][0];
}
