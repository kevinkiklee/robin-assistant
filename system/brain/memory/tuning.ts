// system/brain/memory/tuning.ts
import { createHash } from 'node:crypto';
import type { ProvenanceClass } from './provenance.ts';

/**
 * Every belief-lifecycle constant in one place. Production never calls
 * setTuning, so getTuning() always returns DEFAULT_TUNING (the values these
 * constants had before they moved here). The test lab sets one tuning per
 * process to compare configurations.
 */
export interface MemoryTuning {
  promotionThreshold: Record<ProvenanceClass, number>;
  freshnessTtlDays: Record<ProvenanceClass, number>;
  inferredHalfLifeDays: number;
  decayFloor: number;
  suspectConfidenceThreshold: number;
  promoteAgeDays: number;
  candidateExpiryDays: number;
  conflictExpiryDays: number;
  nearDupRatio: number;
  reconcileBatch: number;
  reconcileMaxPerRun: number;
  expiredLookbackDays: number;
}

export type TuningPatch = {
  [K in keyof MemoryTuning]?: MemoryTuning[K] extends Record<string, number>
    ? Partial<MemoryTuning[K]>
    : MemoryTuning[K];
};

function deepFreeze<T extends object>(o: T): Readonly<T> {
  for (const v of Object.values(o)) if (v && typeof v === 'object') Object.freeze(v);
  return Object.freeze(o);
}

export const DEFAULT_TUNING: Readonly<MemoryTuning> = deepFreeze({
  // P3 — minimum confidence to promote a candidate to a held belief, by class.
  // `external` is Infinity: external readings are live state, never durable
  // beliefs, so they can never promote.
  promotionThreshold: {
    'first-party': 0.5,
    inferred: 0.85,
    'third-party': 0.9,
    external: Number.POSITIVE_INFINITY,
    unknown: 0.8,
  },
  // P2 — freshness TTL in days by class. Infinity = never goes stale.
  freshnessTtlDays: {
    'first-party': Number.POSITIVE_INFINITY,
    inferred: 180,
    'third-party': 120,
    external: 7,
    unknown: 365,
  },
  // Read-time decay half-life for `inferred` beliefs (days).
  inferredHalfLifeDays: 180,
  // Decay never drops effective confidence below this fraction of the stored value.
  decayFloor: 0.5,
  // Effective (post-decay) confidence below this flags a surfaced belief as suspect.
  suspectConfidenceThreshold: 0.7,
  // Candidates younger than this are not promoted by the dream lifecycle pass.
  promoteAgeDays: 7,
  candidateExpiryDays: 14,
  // Conflicted candidates get a longer review window than pending ones: a flagged
  // contradiction is worth more human-review time than an un-adjudicated claim.
  conflictExpiryDays: 30,
  // Near-duplicate merge: levenshtein / longer-length below this ratio merges.
  nearDupRatio: 0.2,
  // Candidates per reconcile judge call.
  reconcileBatch: 20,
  // Candidates judged per nightly dream run — bounds spend to two small calls.
  reconcileMaxPerRun: 40,
  // Expired conflicts older than this are left alone by `--include-expired`.
  expiredLookbackDays: 120,
});

let current: Readonly<MemoryTuning> = DEFAULT_TUNING;

export function getTuning(): Readonly<MemoryTuning> {
  return current;
}

type RecordKey = 'promotionThreshold' | 'freshnessTtlDays';
type ScalarKey = Exclude<keyof MemoryTuning, RecordKey>;

const unit = (v: number) => Number.isFinite(v) && v >= 0 && v <= 1;
const nonNeg = (v: number) => Number.isFinite(v) && v >= 0;
const posInt = (v: number) => Number.isInteger(v) && v >= 1;

const SCALAR_RULES: Record<ScalarKey, (v: number) => boolean> = {
  inferredHalfLifeDays: (v) => Number.isFinite(v) && v > 0,
  decayFloor: unit,
  suspectConfidenceThreshold: unit,
  nearDupRatio: unit,
  promoteAgeDays: nonNeg,
  candidateExpiryDays: nonNeg,
  conflictExpiryDays: nonNeg,
  expiredLookbackDays: nonNeg,
  reconcileBatch: posInt,
  reconcileMaxPerRun: posInt,
};
const RECORD_RULES: Record<RecordKey, (v: number) => boolean> = {
  promotionThreshold: (v) => v === Number.POSITIVE_INFINITY || unit(v),
  freshnessTtlDays: (v) => v === Number.POSITIVE_INFINITY || (Number.isFinite(v) && v > 0),
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && Object.getPrototypeOf(v) === Object.prototype;
}

/** Throws on unknown keys, wrong shapes or out-of-range values. Arm configs go through this. */
export function validateTuningPatch(patch: unknown): asserts patch is TuningPatch {
  if (!isPlainObject(patch)) throw new Error('tuning patch must be a plain object');
  for (const [key, value] of Object.entries(patch)) {
    if (!Object.hasOwn(DEFAULT_TUNING, key)) throw new Error(`unknown tuning key: ${key}`);
    if (Object.hasOwn(RECORD_RULES, key)) {
      if (!isPlainObject(value)) throw new Error(`tuning ${key} must be an object`);
      const base = DEFAULT_TUNING[key as RecordKey];
      const ok = RECORD_RULES[key as RecordKey];
      for (const [member, v] of Object.entries(value)) {
        if (!Object.hasOwn(base, member)) throw new Error(`unknown tuning key: ${key}.${member}`);
        if (typeof v !== 'number' || !ok(v)) {
          throw new Error(`invalid tuning value: ${key}.${member}=${String(v)}`);
        }
      }
    } else if (typeof value !== 'number' || !SCALAR_RULES[key as ScalarKey](value)) {
      throw new Error(`invalid tuning value: ${key}=${String(value)}`);
    }
  }
}

export function setTuning(patch: TuningPatch): void {
  validateTuningPatch(patch);
  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    const base = (current as unknown as Record<string, unknown>)[key];
    next[key] =
      base && typeof base === 'object' ? { ...(base as object), ...(value as object) } : value;
  }
  current = deepFreeze(next as unknown as MemoryTuning);
}

export function resetTuning(): void {
  current = DEFAULT_TUNING;
}

/** Short hash of a tuning, Infinity-safe. Stamped into lab artifacts and cache keys. */
export function tuningHash(t: Readonly<MemoryTuning> = getTuning()): string {
  const json = JSON.stringify(t, (_k, v) =>
    typeof v === 'number' && !Number.isFinite(v) ? String(v) : v,
  );
  return createHash('sha256').update(json).digest('hex').slice(0, 16);
}
