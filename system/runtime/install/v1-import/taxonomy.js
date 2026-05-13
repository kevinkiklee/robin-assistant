// taxonomy.js — fixed vocabularies used during v1 → v2 import.
//
// Spec: docs/superpowers/specs/2026-05-11-v1-to-v2-data-migrator-design.md.

/**
 * Map a v1 knowledge subdir to a v2 `entities.type`.
 * Lookups use the first path segment of `<relative_path>`. Anything not listed
 * falls through to 'concept'.
 */
const KNOWLEDGE_SUBDIR_TO_TYPE = {
  'service-providers': 'service',
  locations: 'place',
  projects: 'project',
  events: 'event',
  // 'medical' intentionally NOT here — defaults to 'concept'. Person doctors
  // live in profile/people/ if they're person entities at all.
};

const DEFAULT_ENTITY_TYPE = 'concept';

/**
 * Resolve a path relative to v1's `memory/knowledge/` to an entity type.
 * `recipes.md` (root flatfile) → 'concept'. `service-providers/google.md` →
 * 'service'.
 */
export function entityTypeForKnowledgePath(relPath) {
  const seg = String(relPath).split('/')[0];
  if (!seg.includes('.')) return KNOWLEDGE_SUBDIR_TO_TYPE[seg] ?? DEFAULT_ENTITY_TYPE;
  return DEFAULT_ENTITY_TYPE;
}

/**
 * v1 frontmatter has `decay: slow | medium | fast | immortal`. Map to a
 * confidence seed value used when creating the memo. The freshness function
 * in v2 combines confidence with a kind-derived half-life so we don't need a
 * separate decay axis.
 */
const DECAY_TO_CONFIDENCE = {
  slow: 0.9,
  medium: 0.7,
  fast: 0.5,
  immortal: 1.0,
};

const DEFAULT_CONFIDENCE = 0.7;

export function confidenceForDecay(decay) {
  return DECAY_TO_CONFIDENCE[decay] ?? DEFAULT_CONFIDENCE;
}

/**
 * Persona-facet → structured persona field projection.
 *
 * Each entry maps a facet slug (basename of `profile/<slug>.md` without `.md`)
 * to a projector function: `(body, frontmatter) → object` that returns a
 * sparse object whose keys are persona-table field names. Multiple facets may
 * project into the same field; persona-writer deep-merges results, so
 * `personality`, `character`, and `communication-style` all contribute to
 * `comm_style` without clobbering each other.
 */
export const PERSONA_FACET_MAP = {
  identity: identityProjector,
  interests: interestsProjector,
  personality: commStyleProjector,
  character: commStyleProjector,
  'communication-style': commStyleProjector,
  routines: routinesProjector,
};

function identityProjector(body) {
  // body is the markdown after frontmatter. We look for `**Name:**` and
  // `**Pronouns:**` style fields, common in v1 profile files.
  const out = {};
  const name = matchBold(body, /Name/i);
  if (name) out.name = name;
  const pronouns = matchBold(body, /Pronouns/i);
  if (pronouns) out.pronouns = pronouns;
  return out;
}

function interestsProjector(body) {
  // Extract top-level bullets as interest tags.
  const tags = [];
  for (const rawLine of body.split(/\r?\n/)) {
    const m = rawLine.match(/^[-*+]\s+\*?\*?([^*:\n]{1,80})\*?\*?(?::|—|$)/);
    if (m) {
      const t = m[1].trim();
      if (t.length > 0 && t.length <= 80) tags.push(t.toLowerCase());
    }
  }
  if (tags.length === 0) return {};
  // Dedup, cap at 32.
  const seen = new Set();
  const unique = [];
  for (const t of tags) {
    if (seen.has(t)) continue;
    seen.add(t);
    unique.push(t);
    if (unique.length >= 32) break;
  }
  return { interests: unique };
}

function commStyleProjector(body, _fm, { facet_slug } = {}) {
  // Don't try to pull individual fields out of the prose; instead, stash the
  // full body under a slug-keyed sub-object. Deep-merge in persona-writer
  // keeps all three commstyle-feeding facets without conflict.
  return { comm_style: { [facet_slug ?? 'unknown']: body.trim() } };
}

function routinesProjector(body) {
  return { meta: { routines: body.trim() } };
}

/**
 * Detect whether a preference reads as a profile-update style rule.
 * Returns 'profile_update' if matched, else null (caller defaults to 'behavior').
 */
const PREFERENCE_KIND_DETECTORS = [
  (text) => (/\b(call|refer to|name)\b.+?\b(as|is)\b/i.test(text) ? 'profile_update' : null),
];

export function detectRuleKind(text) {
  for (const fn of PREFERENCE_KIND_DETECTORS) {
    const k = fn(text);
    if (k) return k;
  }
  return 'behavior';
}

// Helpers
function matchBold(body, keyRx) {
  // Match `**Key:** value` at line start, optionally preceded by a bullet
  // marker (`-`, `*`, `+`) and whitespace.
  const rx = new RegExp(`(?:^|\\n)\\s*[-*+]?\\s*\\*\\*${keyRx.source}:\\*\\*\\s+([^\\n]+)`, 'i');
  const m = body.match(rx);
  return m ? m[1].trim() : null;
}
