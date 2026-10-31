import { createHash } from 'node:crypto';
import { operatorProfile } from '../../lib/operator-profile.ts';

/**
 * System prompts for memory cognition, overridable per process so the test lab
 * can run prompt variants and keep the real user context out of simulated
 * runs. Production never calls setPrompts.
 */
export type PromptKey =
  | 'biographer.userContext'
  | 'biographer.entities'
  | 'biographer.claims'
  | 'biographer.sessionSummary'
  | 'reconcile.judge'
  | 'dream.entityProfile';

const DEFAULTS: Record<PromptKey, string> = {
  // Knowing WHO the user is lets the biographer pick the right entity types (a
  // camera model → gear, not thing; a named cafe → restaurant, not org). Empty in
  // code: the operator's context comes from user-data/config/operator.yaml.
  'biographer.userContext': '',
  'biographer.entities': `You extract structured PERSONAL entities and relations about {{USER_NAME}}'s life from a transcript. Reply ONLY with JSON matching:
{"entities":[{"type":"<type>","name":"...","domain":"<personal domain>"}, ...], "relations":[{"subject":"name","predicate":"verb","object":"name"}, ...]}

{{USER_CONTEXT}}

This transcript is LIKELY DOMINATED BY SOFTWARE ENGINEERING. Extract ONLY entities that belong to {{USER_NAME}}'s personal life, and tag each with a "domain" from: health, finance, career, relationships, preferences, creative, travel, home, life_events, identity, directives. An entity that does not fit one of these domains is engineering/transient noise — OMIT it (do not invent a domain).

Valid <type> values (use the MOST SPECIFIC that fits):
  person, place, restaurant, organization, company, service, product, gear,
  camera, lens, financial_account, medication, event, project, book, film,
  album, artist, song, species, topic, thing.
Use "thing" ONLY when nothing more specific applies, and only if it still fits a personal domain.

Relation rules:
- Use a SPECIFIC, MEANINGFUL predicate — a verb phrase describing a real directed
  relationship (e.g. "lives_in", "works_at", "owns", "photographed_at", "prescribed").
- Subject = the actor/owner; object = the target/thing acted upon. Always maintain
  this direction so "{{USER_NAME}} works_at Acme" and "Acme employs {{USER_NAME}}" aren't both
  emitted — pick one canonical direction (prefer {{USER_NAME}} as subject for their own actions).
- Do NOT use vague co-occurrence predicates: "related_to", "associated_with",
  "mentioned_with", "appears_with", "occurs_with". If no clear directed
  relationship exists, omit the relation entirely.
- NORMALIZE predicates to a canonical form: use "works_at" not "employed_by",
  "lives_in" not "resides_at", "owns" not "possesses", "uses" not "utilizes".

Do NOT extract: transcript role markers; bare numbers/state flags/git SHAs; single-character names; engineering artifacts (commit messages, PR titles, build flags, codenames, code variable names, schema fields, CLI flags); Robin's own internals.

If nothing personal is worth extracting, reply {"entities":[],"relations":[]}.`,
  'biographer.claims': `You extract DURABLE PERSONAL FACTS about {{USER_NAME}} from a transcript. Reply ONLY with JSON matching:
{"claims":[{"topic":"<short-kebab-topic>","claim":"<one declarative sentence>","confidence":<0..1>,"domain":"<one of the domains below>"}, ...]}

This transcript is LIKELY DOMINATED BY SOFTWARE ENGINEERING — on Robin itself or on {{USER_NAME}}'s other projects. Do NOT extract engineering artifacts or state: code, functions, files, configs, bugs, commits, architecture, libraries, tools, build systems, schemas, or Robin's own internals. Those are NOT memory.

Extract ONLY facts that belong to one of these personal domains, and tag each with its "domain":
- health — medical, fitness, sleep, body, conditions, medications
- finance — accounts, investments, taxes, purchases, income
- career — job, role, employer, work history, professional goals
- relationships — family, friends, social ties
- preferences — tastes, opinions, likes/dislikes (food, media, style)
- creative — photography, gear, creative practice and hobby projects
- travel — trips taken or planned, places visited
- home — residence, household, possessions
- life_events — milestones, personal schedule, plans of personal significance
- identity — background, traits, worldview, who {{USER_NAME}} is
- directives — a STANDING rule {{USER_NAME}} sets for how they work or how Robin should behave (durable workflow/tooling preference), e.g. "use pnpm, never npm", "run the tests before committing". NOT a one-time task about the current code ("refactor X to use zod") and NOT a transient build state.

Rules:
- A claim must still be true in a future session. When a personal fact appears IN PASSING during technical work, KEEP it and tag its domain.
- If a fact does not fit one of the domains above, OMIT it — do not invent a domain.
- topic: a short kebab-case key (e.g. "job-role", "home-location", "favorite-food").
- confidence: your 0..1 confidence that this is a durable, correct fact.
If nothing durable and personal is present, reply {"claims":[]}.`,
  'biographer.sessionSummary': `You summarize a completed conversation session. You receive the opening (and closing, if multi-part), plus entities/relations extracted from the full session. Reply ONLY with JSON matching the schema.

Schema: {"intent":"...","outcome":"completed|partial|abandoned|exploratory","outcomeSummary":"...","topics":["kebab-tags"],"decisions":[{"choice":"...","reasoning":"..."}],"temporalRefs":[{"reference":"...","resolvedDate":"YYYY-MM-DD"|null}],"followUp":"..."|null}

Rules:
- intent: one sentence — why the user started this session
- outcome: classify the PRIMARY stated goal (completed/partial/abandoned/exploratory)
- outcomeSummary: one sentence — what was accomplished or why it stopped
- topics: 2-7 kebab-case tags at the life/project level (e.g. "sourdough-starter", "bike-fit", "coast-trip") — not code symbols. Reuse existing topic tags when the subject matches a prior session.
- decisions: only EXPLICIT choices with stated reasoning. Empty array if none.
- temporalRefs: dates/deadlines mentioned. Resolve relative refs against the session date. null resolvedDate if too vague to resolve.
- followUp: an explicit next step the user stated, or null`,
  'reconcile.judge': [
    'You maintain a personal memory store about {{USER_NAME}}. Each ITEM pairs the CURRENT belief on a topic with a NEW candidate claim on the same topic key; label the candidate.',
    "'same': the new claim states the same fact as the current belief, adding nothing material (a rewording, or a less detailed restatement).",
    "'refines': the new claim KEEPS ALL of the current belief's information, or is strictly more specific or more current about the same fact (e.g. current 'favorite tea is green tea' vs new 'favorite tea is green tea, since spring'; a tentative plan that is now confirmed). Only answer refines when replacing the current belief with the new claim loses nothing true.",
    "'contradicts': the two cannot both be true now (a changed value, a negation, a different person/place/date for the same slot) and the new claim does not read as a later update of the current one.",
    "'unrelated': the two are about different facts that happen to share a topic key.",
    'When unsure between refines and anything else, do NOT answer refines — a wrong refines overwrites a true belief.',
    'Return JSON only: {"verdicts":[{"item":<n>,"verdict":"same"|"refines"|"contradicts"|"unrelated"}, …]} covering every item.',
  ].join(' '),
  'dream.entityProfile': `You synthesize a 1-3 sentence profile of an entity from observed relations. Be concise, factual, no preamble. Avoid speculation; only state what the observations support.`,
};

/** Every prompt key, in registry order. */
export const PROMPT_KEYS: readonly PromptKey[] = Object.keys(DEFAULTS) as PromptKey[];

/** The code default for `key`, before any override or `{{USER_NAME}}`/`{{USER_CONTEXT}}` fill. */
export function getDefaultPrompt(key: PromptKey): string {
  return DEFAULTS[key];
}

let overrides: Partial<Record<PromptKey, string>> = {};

/**
 * Effective prompt: override, else default, with `{{USER_NAME}}` and (entities
 * only) `{{USER_CONTEXT}}` filled from the operator profile. Any override means a
 * lab run — the real profile is never read then, so simulated runs stay generic.
 */
export function getPrompt(key: PromptKey): string {
  const labRun = Object.keys(overrides).length > 0;
  const profile = labRun ? null : operatorProfile();
  const name = profile?.name ?? 'the user';
  if (key === 'biographer.userContext') {
    return overrides[key] ?? profile?.context ?? DEFAULTS[key];
  }
  let text = (overrides[key] ?? DEFAULTS[key]).replaceAll('{{USER_NAME}}', () => name);
  if (key === 'biographer.entities') {
    const ctx = getPrompt('biographer.userContext');
    text = text.replaceAll('{{USER_CONTEXT}}', () => ctx);
  }
  return text;
}

export function setPrompts(next: Partial<Record<PromptKey, string>>): void {
  for (const key of Object.keys(next)) {
    if (!(key in DEFAULTS)) throw new Error(`unknown prompt key: ${key}`);
  }
  overrides = { ...overrides, ...next };
}

export function resetPrompts(): void {
  overrides = {};
}

/**
 * Hash of the EFFECTIVE text of every prompt (overrides applied, tokens filled).
 * A production prompt edit changes it too, so lab response-cache keys built on
 * it never serve a stale answer.
 */
export function promptRegistryVersion(): string {
  const canonical = JSON.stringify(PROMPT_KEYS.map((k) => [k, getPrompt(k)]));
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}
