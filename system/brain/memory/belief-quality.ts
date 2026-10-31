import { operatorName, operatorProfile } from '../../lib/operator-profile.ts';

// ─── Dev-artifact / Robin-internals belief-claim filter ──────────────────────
// The hard backstop for the soft prompt rule "beliefs are about the operator's life, not
// Robin's machinery". Extracted to its own module (no brain/ imports) so BOTH belief
// write paths can enforce it without a circular import:
//   1. belief-candidate.ts — biographer-drafted candidates (draft + promote time)
//   2. belief.ts `believe()` — DIRECT writes (daily-brief / dream synthesis, MCP
//      `believe` tool). This path historically bypassed the filter, which is how
//      `robin-belief-topic-canonicalization-needed` (a belief ABOUT Robin's own
//      belief churn) got minted 2026-06-08.
//
// A claim is dropped when its text is *about the machinery*, not about the operator's
// life. Matched on the claim body (not the topic slug) so paraphrases are caught.
// Tokens here must be UNAMBIGUOUSLY about machinery — never part of a durable
// life-fact. Ambiguous tokens that also appear in legit user preferences (pnpm,
// Next.js/`.js`, vercel, "deploys to", playwright, sqlite, schema, migration) are
// deliberately EXCLUDED: the machinery claims that use them all lead with
// "Robin"/"askrobin", which the leading-subject check below catches. Keeping them
// here would drop the prompt's own keep-example ("<operator> prefers pnpm").
const DEV_ARTIFACT_CLAIM_RE =
  /\b(launchd|daemon|cron(?:tab|\s?job)?|plist|monorepo|turborepo|dockerfile|docker image|pulumi|fly\.io|recall\.js|_journal\.json|robinmark|integration tick|integration count|\d+\s+(?:active\s+|configured\s+|installed\s+|enabled\s+)?integrations?|belief topics?|belief candidates?|belief churn|topic canonicalization|canonicalization pass|writer-conflict|decision[ -]replay|biographer|dream pass|hygiene pass|cognition job|mcp servers?|mcp__|mcp tool|claude code|claude agent sdk|analytics-mcp|chrome-devtools|\.claude\.json|~\/\.claude|tsconfig|github integration|github repository|npm package|surrealdb|sqlite wal|vector index|vitest|playwright|biome|cli-in-vm|vm image|shell-mux|send-keys|infra\/|apps\/web|repo(?:sitory)? (?:contains|structure|layout)|zsh alias|shell config|launch agent|capture-rules|design (?:token|system)|brand accent)\b/i;

// Transient / episodic observations wrongly drafted as durable beliefs — WHOOP
// daily-recovery sequences, "resolved on night N", dated metric arrows. These
// are point-in-time readings (belong in the event stream, decay within days),
// not stable facts. Tuned NOT to catch durable patterns that merely use arrows
// (walking routes "Stop A → Stop B", playlist sequences).
const TRANSIENT_CLAIM_RE =
  /(resolved on night|fully resolved as of|recovery climbed|provisional[- ]rescore|\d+%?\s*\(\d{1,2}\/\d{1,2}\)\s*→|\brecovery (?:hit|dipped|dropped|climbed)\b)/i;

/**
 * Returns true when a candidate claim is about Robin's own internals or
 * engineering artifacts (not the operator's life), OR is a transient episodic reading
 * (not a durable fact) — the hard backstop for the soft prompt rules. Dropped
 * before reaching the candidate queue and before any direct `believe()` write.
 * Self-referential ("Robin runs as…", "Robin's scheduler…") and infra-shaped
 * ("askrobin.io caches rendered pages") are caught by both the regex and the
 * leading-subject checks.
 */
export function isLowQualityClaim(_topic: string, claim: string): boolean {
  const c = claim.trim();
  if (DEV_ARTIFACT_CLAIM_RE.test(c)) return true;
  if (TRANSIENT_CLAIM_RE.test(c)) return true;
  // Self-referential claims whose SUBJECT is the assistant / its sites / its
  // packages — not the operator. The grammatical subject is the discriminator: a claim
  // ABOUT the machinery is noise; a claim about the operator that merely mentions it
  // (e.g. "<operator>'s GitHub username is …", "<operator> owns askrobin.io") is a real
  // life-fact and is intentionally NOT matched here.
  //   "Robin …", "Robin's …", "The Robin …", "askrobin…", "The askrobin.io …",
  //   "<operator>'s Robin assistant …", "<operator>'s askrobin.io instance …"
  if (/^(the\s+)?(robin|askrobin)\b/i.test(c)) return true;
  if (ownerRobinRe().test(c)) return true;
  // Claims whose subject is a Robin package/repo, not the operator.
  if (/^(robin-assistant|_robin-sync|robin-cursor|robin-gemini)/i.test(c)) return true;
  // Subject is the MCP surface or a *.io project's internals.
  if (/^(mcp__|the\s+\S+\.io\s+(project|vm|app|site|deployment|image))/i.test(c)) return true;
  return false;
}

/**
 * The configured operator's first name (user-data/config/operator.yaml), or null
 * when none is set. First token only, so a "First Last" profile still matches the
 * bare-first-name forms ("Sam's …", slug token `sam`) these filters target.
 */
export function operatorFirstName(): string | null {
  return operatorName('').trim().split(/\s+/)[0] || null;
}

/**
 * `<first>'?s` (plus `<alias>'?s` per configured alias) as an escaped regex
 * alternation, or null when neither a name nor an alias is set.
 */
export function operatorPossessivePattern(): string | null {
  const names = [operatorFirstName(), ...operatorProfile().aliases].filter((n): n is string => !!n);
  if (names.length === 0) return null;
  return names.map((n) => `${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'?s`).join('|');
}

// "<operator>'s Robin …" / "<alias>'s askrobin …" — rebuilt only when the configured name changes.
let ownerRe: { key: string | null; re: RegExp } | null = null;
function ownerRobinRe(): RegExp {
  const key = operatorPossessivePattern();
  if (!ownerRe || ownerRe.key !== key) {
    // No name or alias configured → a pattern that never matches.
    const owners = key ?? '(?!)';
    ownerRe = { key, re: new RegExp(`^(${owners})\\s+(the\\s+)?(robin|askrobin)\\b`, 'i') };
  }
  return ownerRe.re;
}
