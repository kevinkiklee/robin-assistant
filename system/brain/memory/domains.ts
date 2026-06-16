/**
 * The closed set of personal-life domains Robin's memory is allowed to hold
 * (Phase D, domain-gated ingestion). The biographer extracts ONLY facts/entities
 * in one of these domains; anything outside is engineering/transient noise and is
 * dropped. Inverting the old unbounded dev BLOCKLIST into this finite ALLOWLIST is
 * the whole point: a novel dev concept is excluded by absence, never by a new rule.
 *
 * `directives` is the one door adjacent to dev noise — it holds STANDING rules
 * Kevin sets for how he works / how Robin behaves (durable workflow + tooling
 * preferences). The biographer prompt gates it with the durable-rule-vs-transient-
 * task test; this module only checks set membership.
 */
export const PERSONAL_DOMAINS = [
  'health',
  'finance',
  'career',
  'relationships',
  'preferences',
  'creative',
  'travel',
  'home',
  'life_events',
  'identity',
  'directives',
] as const;

export type PersonalDomain = (typeof PERSONAL_DOMAINS)[number];

const DOMAIN_SET: ReadonlySet<string> = new Set(PERSONAL_DOMAINS);

/** True only for an exact member of the closed personal-domain set. */
export function isPersonalDomain(value: string | null | undefined): value is PersonalDomain {
  return typeof value === 'string' && DOMAIN_SET.has(value);
}
