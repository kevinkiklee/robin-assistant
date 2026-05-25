/**
 * Provenance & epistemic policy — the single source of truth for how Robin
 * weighs a belief. Every phase of the belief lifecycle (P1 surface, P2
 * freshness, P3 formation gate, P4 reconcile) imports these primitives; none
 * redefine them. Keeping classification, thresholds, TTLs and decay in one
 * module means the policy is tunable in exactly one place.
 */

/**
 * Where a belief's evidence came from. This matters as much as confidence: a
 * first-party statement from Kevin and a third-party recruiter's guess are not
 * equally trustworthy even at identical nominal confidence.
 */
export type ProvenanceClass =
  | 'first-party' // Kevin stated it, or it's from his own writing
  | 'inferred' // Robin derived it from indirect signals
  | 'third-party' // someone else asserted it
  | 'external' // integration/API reading — lag-prone, NOT a durable belief
  | 'unknown'; // unclassified (pre-spine beliefs, or underivable)

/** Classes whose claims warrant a scrutiny tag when surfaced (P1 suspect test). */
export const WEAK_PROVENANCE: ReadonlySet<ProvenanceClass> = new Set<ProvenanceClass>([
  'inferred',
  'third-party',
  'external',
]);

/** Confidence (effective, post-decay) below this flags a surfaced belief as suspect. */
export const SUSPECT_CONFIDENCE_THRESHOLD = 0.7;

/**
 * P3 — minimum confidence to promote a candidate to a held belief, by class.
 * `external` is Infinity: external readings are live state (read from the
 * integration on demand), never durable beliefs, so they can never promote.
 */
export const PROMOTION_THRESHOLD: Record<ProvenanceClass, number> = {
  'first-party': 0.5,
  inferred: 0.85,
  'third-party': 0.9,
  external: Number.POSITIVE_INFINITY,
  unknown: 0.8,
};

/** P2 — freshness TTL in days by class. Infinity = never goes stale. */
export const FRESHNESS_TTL_DAYS: Record<ProvenanceClass, number> = {
  'first-party': Number.POSITIVE_INFINITY,
  inferred: 180,
  'third-party': 120,
  external: 7,
  unknown: 365,
};

/** Read-time decay half-life for `inferred` beliefs (days). */
const INFERRED_HALF_LIFE_DAYS = 180;
/** Decay never drops effective confidence below this fraction of the stored value. */
const DECAY_FLOOR = 0.5;

/** Map a single event `kind` to the provenance class it implies. */
function kindToClass(kind: string): ProvenanceClass {
  if (kind.startsWith('integration.')) return 'external';
  if (kind.startsWith('session.') || kind.startsWith('capture.')) return 'first-party';
  if (kind.startsWith('dream.') || kind.startsWith('biographer.') || kind.startsWith('reasoning'))
    return 'inferred';
  return 'unknown';
}

/**
 * Classify provenance from the `kind`s of the events that sourced a claim.
 * Deterministic. A first-party signal (Kevin said it) is the strongest and
 * wins outright — corroboration from an integration does not weaken it. Absent
 * first-party evidence, the weakest applicable class wins, so we never
 * over-trust. Empty or wholly unrecognized input → `unknown`.
 */
export function classifyProvenance(sourceEventKinds: string[]): ProvenanceClass {
  const classes = new Set(sourceEventKinds.map(kindToClass));
  if (classes.has('first-party')) return 'first-party';
  // Weakest-wins ordering among the remaining (non-first-party) classes.
  for (const c of ['external', 'third-party', 'inferred'] as const) {
    if (classes.has(c)) return c;
  }
  return 'unknown';
}

/** Days elapsed since an ISO timestamp; invalid input or future dates → 0. */
export function ageDaysFrom(iso: string, now: number = Date.now()): number {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 0;
  return Math.max(0, (now - t) / 86_400_000);
}

/** Whether a belief of the given class has aged past its freshness TTL. */
export function isStale(ageDays: number, cls: ProvenanceClass): boolean {
  return ageDays > FRESHNESS_TTL_DAYS[cls];
}

/**
 * Read-time confidence multiplier. Only `inferred` beliefs decay (an old guess
 * should assert less forcefully); everything else holds its stored confidence.
 * Floored at `DECAY_FLOOR` so a decayed belief never silently vanishes.
 */
export function confidenceDecay(ageDays: number, cls: ProvenanceClass): number {
  if (cls !== 'inferred') return 1;
  return Math.max(DECAY_FLOOR, 0.5 ** (ageDays / INFERRED_HALF_LIFE_DAYS));
}

/** Stored confidence shaded by age-decay for its class. `null` passes through. */
export function effectiveConfidence(
  stored: number | null,
  ageDays: number,
  cls: ProvenanceClass,
): number | null {
  if (stored == null) return null;
  return stored * confidenceDecay(ageDays, cls);
}
