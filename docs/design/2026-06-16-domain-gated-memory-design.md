# Domain-Gated Memory Ingestion — Design

- **Date:** 2026-06-16
- **Status:** Draft (pending review)
- **Author:** Kevin + Robin (brainstorming session)
- **Area:** `system/brain/cognition/` (biographer, capture, hygiene), `system/brain/memory/` (belief-candidate, provenance)
- **Builds on:** `2026-06-10-trust-feedback-memory-design.md` (Phase C, shipped). This is the **noise-at-ingestion** complement to that work's **post-ingestion hygiene** — see "Relationship to prior work."

## Problem

Dev/engineering content keeps leaking into Robin's long-term memory. Three
facets, all confirmed by Kevin:

1. **Reactive whack-a-mole (A).** Noise prevention is a *blocklist* —
   `BLOCKED_ENTITY_TYPES`, `isLowQualityEntity()`, `noise_blocklist`, hygiene
   Tier 1/2, and the `isLowQualityClaim()` dev-artifact block already inside
   `believe()`. The last five commits all narrow "what is noise" a little
   further upstream. The space of dev concepts is unbounded, so the blocklist is
   patched forever. The self-capture loop alone recurred **three times**, each
   fix reactive.
2. **Dev content still leaks (B).** Anything dev-related gets through.
3. **The store is already polluted (C).** Accumulated dev entities, duplicate
   nodes, low-value `thing`/`topic` jargon need cleaning.

### Root cause

Robin's capture cwd allowlist **defaults to the robin repo itself**, so every
"let's fix the biographer" session is in-scope for extraction. The biographer's
job is to extract facts about Kevin's *life*, but the transcripts it reads are
dominated by engineering work *on Robin and other projects*. The current claims
prompt is already positive — *"You extract DURABLE FACTS about the user"*
(`biographer.ts:169`) — and still fails, because a negative "avoid dev" framing
can't enumerate an unbounded set. The prompt even **teaches** dev noise by
example: `SESSION_SUMMARY_PROMPT` lists `"leadforge-auth"` as a topic exemplar
(`biographer.ts:164`).

We do **not** narrow the cwd allowlist itself: Kevin also has genuine personal
conversations *inside* the robin repo (his daily driver), so excluding the repo
would lose real facts. Filtering is post-capture by design; the lever is *what
gets extracted*, not *what gets captured*.

### Source ranking (Kevin)

1. **D — mixed sessions** (a real personal fact *and* dev entities in the same
   transcript). The dominant case, and the hardest: must keep the flight, drop
   the function, *within one extraction*.
2. **C — cognition echo** (Robin's own prompts looping back through capture).
3. **A — Robin working on itself** (pure-dev sessions in this repo).

### Aggressiveness dial (Kevin)

Asymmetric (Q3-C) **and** recall-biased (Q3-B): **zero tolerance** for the
obvious-junk end (code symbols, commits, SHAs, `io.robin-assistant.*`,
Robin-internal machinery — these never rely on LLM judgment), but **keep when
uncertain** about a borderline *personal* fact. Clean is the goal, but dropping
a real life fact is worse than letting some junk through to be swept by hygiene.

## Relationship to prior work (Phase C, shipped)

`2026-06-10-trust-feedback-memory-design.md` shipped Phase C: **hygiene on what
already entered** — `canonicalizeTopic()` (one belief head per fact), risk-
weighted freshness re-query, the `claim_failures` dead-letter retry, and entity-
profile staleness. **None of it filters what enters at extraction.** This design
is the **ingestion-boundary complement** — treat it as Phase D. Concretely:

- **Reuse, don't reinvent.** Component 4's cleanup mirrors the established
  `robin beliefs canonicalize` maintenance idiom (dry-run default, audit events,
  idempotent, CLI subcommand). Surfacing signals reuses Phase A's `alerts`
  channel. Similarity/dedup reuses `levenshtein` + the candidate-merge gate.
- **Extend the existing dev-artifact block.** `believe()` already calls
  `isLowQualityClaim()` to reject dev artifacts — but only for *beliefs*, and as
  a reactive pattern blocklist. Component 3 adds the `domain` axis to that same
  choke point rather than adding a parallel filter.
- **Honor the binding cost stance.** Phase C's design states *zero new LLM
  spend* as a binding constraint (subscription quota is tight; see the
  "iser3000 weekly limit" history). Components 1–3 add **zero new LLM calls**
  (domain judgment rides the extraction call that already runs). Component 4's
  cleanup is **deterministic-first**; any LLM classification is **optional and
  budget-gated**, off by default.

## The reframe: artifact/state vs. durable fact-or-directive

The boundary is **not** "dev vs. personal." A blanket "drop all dev" would
delete a *legitimate* memory — e.g. the belief *"Kevin's LLM Assistant Rules
mandate `pnpm dev:log` as the required dev command"* is dev-flavored but a
durable **directive** about how Kevin works, and is wanted.

The real line:

| Drop (transient engineering artifact / state) | Keep (durable fact / directive about Kevin) |
| --- | --- |
| code symbols, functions, files, configs, bugs | health, finance, career, relationships |
| commits, SHAs, branches, PRs, CI state | preferences, tastes, opinions |
| libraries, frameworks, tools-as-tech | travel, home, possessions, life events |
| Robin internals, cognition machinery | photography / creative practice |
| architecture decisions, schema, migrations | **directives**: how Kevin works, rules he sets for Robin/tooling |

### The `directives` domain is the widest re-entry door — gate it sharply

`directives` exists to keep durable workflow rules, but it sits right next to dev
noise; "use library X," "the build command is Y," "refactor Z" could all
masquerade as directives. The sub-test, baked into the prompt and the fixtures:

> A `directives` memory is a **standing** instruction or preference Kevin owns
> about *how he works* or *how Robin should behave* — still true next month,
> not tied to a specific code change. The test: *would this be re-stated as a
> rule in CLAUDE.md or a preferences doc (durable → keep) — or is it a one-time
> task about the current codebase (transient → drop)?*

- **Keep:** "commit as kevin.kik.lee@gmail.com"; "`pnpm dev:log` is the required
  dev command"; "never offer `/schedule`"; "no end-of-response summaries"; "use
  Context7 for library docs."
- **Drop:** "refactor `biographer.ts` to use zod"; "the build is failing"; "add
  a `domain` column"; "this function should return early."

## Approach

Invert the filter from an unbounded **blocklist** to a closed **personal-domain
allowlist**, applied at extraction, with cheap whole-session drops for the
unambiguous cases and a bounded retroactive cleanup. Four components, ordered by
blast radius.

### `PERSONAL_DOMAINS` (closed set)

```
health        — medical, fitness, sleep, body, conditions, medications
finance       — accounts, investments, taxes, purchases, income
career        — job, role, employer, work history, professional goals
relationships — family, friends, social ties
preferences   — tastes, opinions, likes/dislikes (food, media, style)
creative      — photography, gear, creative practice and projects-as-hobby
travel        — trips taken or planned, places visited
home          — residence, household, possessions
life_events   — milestones, personal schedule, plans of personal significance
identity      — background, traits, worldview, who Kevin is
directives    — standing rules Kevin sets for how he works / how Robin behaves
                (durable workflow + tooling preferences; gated per the sub-test above)
```

A claim or entity that does not belong to one of these domains is **not
extracted**. The unbounded engineering space is excluded by absence from the
list — no new rule is ever needed for a novel dev concept.

### Component 1 — Personal-domain allowlist in extraction *(backbone)*

**Files:** `system/brain/cognition/biographer.ts`

- Rewrite `CLAIMS_SYSTEM_PROMPT` (`:169`) and the entity-extraction prompt to:
  - extract **only** claims/entities in a `PERSONAL_DOMAINS` domain;
  - **tag each** with its `domain` (schema-enforced enum — `extractionSchema`
    at `:67` gains a `domain` field; invalid/absent domain ⇒ dropped);
  - carry the explicit framing: *"This transcript is likely dominated by
    software engineering on Robin or other projects. Never extract engineering
    artifacts or state — code, commits, configs, bugs, architecture, tools,
    libraries, Robin internals. Extract only durable facts or directives about
    Kevin in the domains listed. When a personal fact appears in passing during
    technical work, keep it."* (Q3-C ruthlessness + Q3-B recall bias.)
- Remove the dev-flavored topic exemplar (`"leadforge-auth"`, `:164`); replace
  with personal-domain examples so the prompt stops teaching dev topics.
- Constrain emitted entity **types** to the personal-relevant set; drop bare
  `thing`/`topic` nodes that don't attach to a personal domain (the high-volume
  Tier-2 jargon leak).
- **Keep** the deterministic backstops (`isLowQualityEntity()`,
  `isLowQualityClaim()`, SHA / commit / `io.robin-assistant.*` / launchd
  patterns) as a hard floor — the zero-tolerance end never depends on LLM
  judgment.
- **Runtime kill-switch.** Gate domain-gating behind an env flag
  (`ROBIN_DOMAIN_GATING`, default on) read via `loadEnvFile`. The daemon serves
  stale in-memory code until a kickstart, so a *code* revert is slow; a runtime
  flag lets a regression be disabled without a redeploy.

**Token cost (honest):** no *new* LLM call — the domain judgment rides the
per-chunk extraction call. The system prompt does grow by the domain list +
framing (~a few hundred tokens/call); with `MAX_CHUNKS_PER_TICK=10` that's a
small fixed per-tick increase, not literally zero. Net within the Phase-C
zero-new-*call* stance.

**Central risk (named, not waved away):** the extraction LLM is the same
component currently over-extracting. The bet is that a *closed enum + per-item
domain tagging + artifact-vs-directive framing* classifies materially better
than a negative "avoid dev" instruction. Validated by the metric below against
human-labeled fixtures, not assumed.

### Component 2 — Session-level pre-extraction gate *(cheap kills for A + C)*

**Files:** `system/brain/cognition/capture.ts`, `biographer.ts`

- **Self-capture, made structural.** Robin owns every transcript path it writes
  (`run-agent.ts:121` → `${transcriptDir}/${ts}-${surface}.jsonl`). Maintain a
  **provenance registry** of those paths; the capture scanner skips any
  registered path deterministically — Robin no longer *guesses* whether a
  transcript is its own, it *knows*. This retires the content-guessing
  `isCognitionEcho()` patch that recurred 3×.
  - **Ordering is load-bearing** (the prior recurrences were race/ordering
    bugs): register the path — or write an atomic sidecar marker — **before**
    the transcript file is created, since the capture scanner is a separate
    ~5-min poller. A transcript must never be scannable before it is registered.
- **Pure-dev sessions.** A cheap heuristic (ratio of code-fence / tool-call /
  command lines, no first-person personal-signal lines) tags a session
  `domain_hint: dev`; tagged sessions skip claim+entity extraction (still
  captured as events for recall/threads, but contribute no durable memory).
- **Conservative by construction.** The gate fires **only** on confident
  pure-dev or registry-matched echo. **Default is fall-through** to Component 1's
  per-claim filter — because the dominant case is *mixed*, and a mis-skip would
  drop a real personal fact (the Q3-B error we most want to avoid).

### Component 3 — `domain` on the existing belief choke point *(defense-in-depth, beliefs only)*

**Files:** `system/brain/memory/provenance.ts`, `belief-candidate.ts`,
`belief.ts`

- Carry `domain` onto belief candidates and belief-update payloads. Extend the
  **existing** `isLowQualityClaim()` dev-artifact block in `believe()` with the
  domain axis: an engineering-artifact domain inherits the `external`-style
  **never-promote** lever (`PROMOTION_THRESHOLD = Infinity`). Reuses the proven
  choke point; no parallel filter.
- **NULL domain grandfathers as promotable.** Existing rows (pre-migration) and
  any untagged write have `domain = NULL`, which means *unknown*, **not**
  engineering — they stay promotable. Only an *explicit* engineering-artifact
  tag triggers never-promote. Otherwise the migration would freeze promotion of
  every legitimate pre-existing candidate.
- **Scope honesty:** this guards **beliefs only**. Entities and relations do not
  pass through the promotion gate — they rely on Component 1 + the deterministic
  backstop + nightly hygiene. We accept that rather than building an entity
  quarantine (over-build for the recall-biased dial; hygiene already sweeps the
  residue).

### Component 4 — Retroactive cleanup sweep *(handles C)*

**Files:** new `system/brain/memory/degate-memory.ts` + a
`robin memory degate` CLI subcommand, mirroring `canonicalize-heads.ts` /
`robin beliefs canonicalize`.

- Re-classify existing entities / relations / belief candidates / beliefs by
  domain and cull the engineering-artifact ones.
- **Deterministic-first (honors the zero-spend stance):** reuse the existing
  pattern filters (`isLowQualityEntity`, `noise_blocklist`, hygiene Tier-1
  regexes) to classify the bulk for free. An LLM pass over the ambiguous
  remainder is **optional, off by default, behind a `--llm` flag and a spend
  cap**, run incrementally on the nightly hygiene cadence if enabled.
- **Reversible & auditable (the established idiom):** dry-run by default,
  printing a decision table (counts by domain + a sample of would-be deletions);
  one `memory.degate` audit event per decision (cf. `belief.canonicalize`);
  idempotent re-runs; a DB snapshot precedes any `--apply` destructive delete.
  Matches Kevin's "instrumented, auditable" preference.

## Success metric

Automatable, no new standing LLM spend, with a human-in-the-loop precision check:

- **Continuous proxy (free):** per biographer tick, record the distribution of
  emitted `domain` tags and the no-domain **drop rate**. A spike or drift is a
  signal; surfaced through Phase A's `alerts` channel when it crosses a band.
- **Precision spot-audit (human, cheap):** `robin memory audit-sample` surfaces
  the last N *kept* extractions grouped by domain for a quick eyeball — catches
  false negatives (dev junk tagged personal) without an LLM judge.
- **Regression gate (CI):** a frozen, **human-labeled** eval-fixture set —
  mixed (flight + function), pure-dev, cognition-echo, directive-bearing
  (`pnpm dev:log` keep vs. "refactor to zod" drop), borderline-personal.
  Labels are ground truth set by Kevin **once**, so the eval can't mark its own
  homework. Asserted by unit tests.
- **Baseline → target:** measure the kept-extraction engineering-artifact
  fraction on current `main` first; target ≤2% **with no regression in
  personal-fact recall** on the fixtures. (Threshold finalized after baseline.)

## Testing

Collocated `*.test.ts` (node:test + assert):

- mixed session → keeps the personal fact, drops the function;
- pure-dev session → all dropped at the gate;
- cognition echo → skipped via the path registry (no content guessing), incl. an
  ordering test: a transcript registered before creation is never scanned;
- directive (`pnpm dev:log`) → **kept** under `directives`; transient task
  ("refactor to zod") → **dropped** (the loophole guard);
- engineering-domain belief candidate → never promotes; **NULL-domain candidate
  → still promotable** (grandfather);
- cleanup dry-run → report-only, zero writes; idempotent re-run → no-op.

## Migrations & sequencing

- `domain TEXT` column on `belief_candidates` (ALTER, à la migration 013) and on
  `entities`. Belief-update payloads are JSON events — `domain` is a payload key,
  no migration.
- **Next free slot is ≥028** (026 = claim_failures, 027 = profile_generated_at
  both shipped). Re-check the migrations dir at implementation time and renumber
  — *the autonomous daemon also lands migrations.*
- Migration must land **before** Component 4 backfills/sweeps existing rows.

## Rollout & constraints

- Ship **Components 1–3** first (forward-looking, low risk; stop new noise),
  behind the `ROBIN_DOMAIN_GATING` flag so a regression is a flag flip.
- Then review **Component 4**'s dry-run audit; execute cleanup (`--apply`) only
  after, with a DB snapshot taken first.
- **Daemon restart after every build** — it serves stale in-memory cognition
  until `launchctl kickstart -k gui/$(id -u)/io.robin-assistant.daemon`.
- **Coordinate with in-flight biographer work** — the last five commits actively
  changed `biographer.ts` (harness-scaffolding strip). Do not revert
  `d7ab658` / `f352c97`; rebase onto the latest extraction changes. The daemon
  edits this tree live, so **never `git add -A`** — stage explicit paths;
  author email `kevin.kik.lee@gmail.com`.

## Out of scope

- Read-time recall ranking (Q1-D) — noise *scoring at recall*, not noise
  *entering*. Separate effort if pursued.
- Entity quarantine table — deferred; hygiene + Component 1 are judged
  sufficient for the recall-biased dial.
- Re-doing Phase C (head canonicalization, freshness, dead-letter, profile
  staleness) — shipped; this builds on it, doesn't touch it.

## Open questions

- Final allowlist wording for `directives` vs. `preferences` overlap — resolved
  during prompt-tuning against the eval fixtures.
- Exact leak-rate threshold and the proxy alert band — set after the baseline
  measurement.
- Whether Component 4's optional `--llm` pass is worth enabling at all given the
  cost stance, or whether deterministic classification covers enough of the
  existing pollution. Decide after seeing the dry-run's deterministic coverage.
