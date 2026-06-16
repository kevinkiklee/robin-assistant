# Domain-Gated Memory Ingestion — Design

- **Date:** 2026-06-16
- **Status:** Draft (pending review)
- **Author:** Kevin + Robin (brainstorming session)
- **Area:** `system/brain/cognition/` (biographer, capture, hygiene), `system/brain/memory/` (belief-candidate, provenance)

## Problem

Dev/engineering content keeps leaking into Robin's long-term memory. Three
facets, all confirmed by Kevin:

1. **Reactive whack-a-mole (A).** Noise prevention is a *blocklist* —
   `BLOCKED_ENTITY_TYPES`, `isLowQualityEntity()`, `noise_blocklist`, hygiene
   Tier 1/2. The last five commits all narrow "what is noise" a little further
   upstream. The space of dev concepts is unbounded, so the blocklist is patched
   forever. The self-capture loop alone recurred **three times**, each fix
   reactive.
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

## The reframe: artifact/state vs. durable fact-or-directive

The boundary is **not** "dev vs. personal." A blanket "drop all dev" would
delete a legitimate memory — e.g. the belief *"Kevin's LLM Assistant Rules
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

`directives` is a first-class personal domain. The test for it: *a stable
instruction or preference Kevin owns*, not a transient fact about the codebase's
current state.

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
directives    — stable instructions/preferences Kevin sets for how he works
                or how Robin should behave (incl. tooling/workflow rules)
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
- **Keep** the deterministic backstops (`isLowQualityEntity()`, SHA / commit /
  `io.robin-assistant.*` / launchd patterns) as a hard floor — the zero-tolerance
  end never depends on LLM judgment.
- **Marginal token cost ≈ zero:** the domain judgment rides the per-chunk
  extraction call the biographer already makes. This is what resolves the
  dominant **D (mixed-session)** case.

**Central risk (named, not waved away):** the extraction LLM is the same
component currently over-extracting. The bet is that a *closed enum + per-item
domain tagging + artifact-vs-directive framing* classifies materially better
than a negative "avoid dev" instruction. This is validated by the metric below,
not assumed.

### Component 2 — Session-level pre-extraction gate *(cheap kills for A + C)*

**Files:** `system/brain/cognition/capture.ts`, `biographer.ts`

- **Self-capture, made structural.** Robin owns every transcript path it writes
  (`run-agent.ts:121` → `${transcriptDir}/${ts}-${surface}.jsonl`). Maintain a
  **provenance registry** of those paths (a table, or a sidecar marker written
  next to each transcript); the capture scanner skips any path in the registry
  deterministically. This retires the content-guessing `isCognitionEcho()` patch
  that recurred 3× — Robin no longer guesses whether a transcript is its own; it
  *knows*.
- **Pure-dev sessions.** A cheap heuristic (ratio of code-fence / tool-call /
  command lines, no first-person personal-signal lines) tags a session
  `domain_hint: dev`; tagged sessions skip claim+entity extraction (still
  captured as events for recall/threads, but contribute no durable memory).
- **Conservative by construction.** The gate fires **only** on confident
  pure-dev or registry-matched echo. **Default is fall-through** to Component 1's
  per-claim filter — because the dominant case is *mixed*, and a mis-skip would
  drop a real personal fact (the Q3-B error we most want to avoid).

### Component 3 — `domain` as a provenance axis *(defense-in-depth, beliefs only)*

**Files:** `system/brain/memory/provenance.ts`, `belief-candidate.ts`

- Carry `domain` onto belief candidates and belief-update payloads. An
  engineering-artifact domain (should be unreachable after Component 1) inherits
  the existing `external`-style **never-promote** lever
  (`PROMOTION_THRESHOLD = Infinity`), so a straggler can't become a promoted
  belief. Reuses a battle-tested gate; no new mechanism.
- **Scope honesty:** this guards **beliefs only**. Entities and relations do not
  pass through the promotion gate — they rely on Component 1 + the deterministic
  backstop + nightly hygiene. We accept that rather than building an entity
  quarantine (over-build for the recall-biased dial; hygiene already sweeps the
  residue).

### Component 4 — Retroactive cleanup sweep *(handles C)*

**Files:** new pass wired into `runHygiene()` (`system/brain/cognition/hygiene.ts`)

- Re-classify existing entities / relations / belief candidates / beliefs by
  domain and cull the engineering-artifact ones.
- **Bounded & cheap:** deterministic patterns first (free); LLM classification
  only on the ambiguous remainder, **batched**, **spend-capped**, run
  **incrementally on the nightly hygiene cadence** rather than one large run.
- **Reversible & auditable:** dry-run by default, emitting an audit report
  (counts by domain + a sample of would-be deletions). A DB snapshot and an
  audit table of deleted rows precede any destructive delete. Matches Kevin's
  "instrumented, auditable" preference.

## Success metric

A **leak rate**: sample N recently-extracted entities + claims, label each as
engineering-artifact vs. durable-personal, report the engineering-artifact
fraction.

- **Baseline:** measure on current `main` before any change.
- **Target:** engineering-artifact fraction below a threshold (set after seeing
  the baseline; provisionally ≤2%) **with no regression in personal-fact
  recall** — verified against the frozen eval-fixture set below.
- A small **eval-fixture set** of real (redacted) session excerpts:
  mixed (flight + function), pure-dev, cognition-echo, directive-bearing
  (`pnpm dev:log`-style), borderline-personal. Asserted by unit tests so the
  classifier's behavior is pinned and regressions are caught.

## Testing

Collocated `*.test.ts` (node:test + assert):

- mixed session → keeps the personal fact, drops the function;
- pure-dev session → all dropped at the gate;
- cognition echo → skipped via the path registry (no content guessing);
- directive (`pnpm dev:log`) → **kept** under `directives` (the reframe);
- engineering-domain belief candidate → never promotes;
- cleanup dry-run → report-only, zero writes.

## Migrations & sequencing

- `domain TEXT` column on `belief_candidates` (ALTER, à la migration 013) and on
  `entities`. Belief-update payloads are JSON events — `domain` is a payload key,
  no migration.
- Migration must land **before** Component 4 backfills existing rows.

## Rollout & constraints

- Ship **Components 1–3** first (forward-looking, low risk; stop new noise).
- Then review **Component 4**'s dry-run audit; execute cleanup only after.
- **Daemon restart after every build** — it serves stale in-memory cognition
  until `launchctl kickstart -k gui/$(id -u)/io.robin-assistant.daemon`.
- **Coordinate with in-flight biographer work** — the last five commits actively
  changed `biographer.ts` (harness-scaffolding strip). Do not revert
  `d7ab658` / `f352c97`; the daemon edits the working tree live, so avoid blind
  `git add -A` and rebase onto the latest extraction changes.

## Out of scope

- Read-time recall ranking (Q1-D) — noise *scoring at recall*, not noise
  *entering*. Separate effort if pursued.
- Entity quarantine table — deferred; hygiene + Component 1 are judged
  sufficient for the recall-biased dial.

## Open questions

- Final allowlist wording for `directives` vs. `preferences` overlap — resolved
  during prompt-tuning against the eval fixtures.
- Exact leak-rate threshold — set after the baseline measurement.
