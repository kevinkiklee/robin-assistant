# Behavioral Habit Inference (Phase 2) — Design

**Status:** Design (awaiting review) · **Date:** 2026-06-17 · **Author:** Robin + Kevin (brainstorm)

## 1. Motivation

When Robin recommended the Nikon Z TC-1.4× one night and Kevin bought it the next
day, that sequence was a *behavioral signal* — it says something about how Kevin
operates (researches deeply, then acts fast on a well-reasoned gear rec; buys gear
ahead of planned trips). Robin captured none of it as a pattern. Today Robin holds
**static facts** ("owns a Zf") and **stated decisions** pulled from session
transcripts, but has no notion of a *habit* — a generalization over many actions —
and no way to let those generalizations sharpen its future reasoning.

This design adds that layer.

## 2. Goals, priorities, scope

**Priority order (Kevin, confirmed):**
1. **(A) Personalization** — Robin understands Kevin's habits/preferences so its
   future recommendations and reasoning are sharper. The payoff is mostly invisible.
2. **(C) Recommendation calibration** — Robin learns which of *its own* advice lands.
3. **(B) Self-awareness surfacing** — Robin occasionally reflects a pattern back to Kevin.

**Scope of signals:** broad — all behavioral streams (purchases, photography cadence,
listening, films, health rhythms, plus decisions extracted from sessions), not just
the recommendation→action loop.

**Confidence stance:** inferred habits are a **soft, hint-grade** class of memory,
structurally separate from facts, used as hints and *never stated as truth* — with a
narrow path to graduate into a stated preference only on overwhelming, repeated
evidence.

### Phasing (this doc = Phase 2 only)

The full system is Approach 2 ("first-class behavioral subsystem"), built in three
phases along the priority order:

- **Phase 1 — Recommendation loop** (serves C): an explicit `recommendations` ledger
  + retroactive action-linker. *Separate spec.*
- **Phase 2 — Habit inference** (serves A, broad): **this document.**
- **Phase 3 — Feedback depth + surfacing** (A payoff polish + B): richer recall
  weighting + calibration views. *Separate spec.*

Phase 2 is designed so the engine consumes a **generic behavioral-signal stream**;
Phase 1's recommendation→action loop later becomes just one more signal source, with
no redesign. Phase 2 does **not** depend on Phase 1.

## 3. Core abstraction — two layers

- **Behavioral signal** = an *already-captured* event reflecting something Kevin did
  or chose (a lunch_money purchase, an `lrc.*` shoot, a `letterboxd.*` watch, a
  `whoop.*` aggregate, a biographer-extracted decision). Phase 2 **does not capture
  these anew** — it reads the firehose and normalizes them at read-time to a common
  shape: `{actor, action, object, domain, ts, context}`.
- **Habit** = a *generalization* over many signals ("tends to buy gear before a
  planned trip", "shoots most at golden hour"). This is the new stored object.

The two layers are deliberately separate: signals are raw and disposable; habits are
soft, durable-ish, and auditable.

### Signal selection (load-critical)

The event stream is ~1.5–4k captured sessions/day plus all integration ticks — the
engine must **never scan the whole firehose.** Selection is by:
- a defined **`BEHAVIORAL_SIGNAL_KINDS` allowlist** (transaction/purchase kinds,
  `lrc.*`, `letterboxd.*`, `spotify.*`, `whoop.*` aggregates, biographer decision
  outputs), and
- an **incremental cursor** (mirrors the biographer's cursor pattern).

## 4. Data model — the `habits` table

A **distinct soft store**, not a reuse of `belief_candidates` (which stays the
*facts* review queue). Habits are structurally separate so Robin can never render a
hint as a fact.

| Field | Purpose |
|---|---|
| `id` | PK |
| `statement` | the habit, phrased as a hedged tendency ("tends to buy camera gear before a planned trip") |
| `domain` | primary domain; reuses `PERSONAL_DOMAINS` (same gate as beliefs). Multi-domain habits pick the primary; only set-membership matters downstream |
| `pattern_kind` | `purchase` \| `temporal` \| `preference` \| `workflow` \| `consumption` |
| `confidence` | 0..1, **soft**; engine-owned (see §6) |
| `support_count` | # distinct supporting signals |
| `support_streams` | # distinct *streams* contributing (single-stream patterns stay weak) |
| `contradiction_count` | best-effort; a *demotion/retire* signal, not a graduation gate |
| `evidence_event_ids` | JSON array of source event ids (may dangle after purges) |
| `evidence_summary` | **text snapshot** of supporting signals at inference time — survives event purges; the audit trail |
| `embedding` | for semantic dedup/upsert and retired-suppression matching |
| `first_seen` / `last_seen` | observation window |
| `last_reinforced` | drives the confidence recency term |
| `status` | `soft` (default) \| `graduated` \| `retired` |
| `graduated_belief_id` | FK → the `preferences` belief_candidate it spawned on graduation (NULL otherwise) |
| `created_at` / `updated_at` | — |

Rationale for `evidence_summary`: Robin purges events aggressively (the self-capture
cleanup deleted ~9k). A JSON id-array cannot `ON DELETE SET NULL`, so a text snapshot
preserves auditability — Kevin's defense against opaque over-assertion.

## 5. The engine — `behavior.run` (two tiers)

A single nightly LLM pass would repeat the dream-synthesis cost trap. Habits change
*slowly*; signals arrive *continuously*. So the engine splits along the same line
Robin already splits deterministic `dream` (3:50am) from LLM `dream-synthesis`
(4:00am):

### Tier A — nightly, deterministic, no LLM (free)
Runs **unconditionally** every night:
1. Recompute every habit's `confidence` from stored state (§6).
2. **Retire** habits past a staleness / low-confidence floor (→ suppression set).
3. **High-precision exact-entity reinforcement only:** a signal naming a specific
   tracked entity (e.g. "Voigt 35") bumps a habit *about that entity*
   (`support_count`, `last_reinforced`). **No fuzzy/semantic matching here** — that is
   exactly the judgment Tier A cannot make.
4. Advance the cursor; **stage** new signals for Tier B.

### Tier B — weekly, LLM synthesis (bounded budget)
Owns **all semantic attribution**:
1. Load staged signals since the last pass (capped at `N`, **prioritized**:
   decision/purchase > consumption) + all `soft`/`graduated` habits + the `retired`
   suppression list. Overflow beyond `N` is **logged and deferred via the cursor to
   the next run — never silently dropped** (Robin's no-silent-caps discipline).
2. One StructuredOutput call proposes: **reinforcements** (this purchase instances the
   gear-before-trips pattern), **new** candidate habits, and **merges**. Instructed
   not to resurrect retired habits.
3. Engine applies results: **creation floor** (§7), embedding-dedup upsert,
   engine-enforced retired-suppression (§8), write `evidence_summary`, set confidence.
4. Emit `habit.inferred` / `habit.reinforced` / `habit.graduated` events and fold
   counts into the existing **24h learning-digest**.

**Cost controls:** Tier B carries a per-run budget modeled on the fixed
`SPECIALIST_BUDGET_USD`; **skips entirely when no new staged signals**; the `N` cap
bounds the prompt; weekly cadence ≈ 4 LLM passes/month. Tier A is free. **Cold start:**
the first Tier B run processes a bounded recent window (~90 days), not all history.

**Known scaling lever (not v1):** if one broad weekly call degrades on context/quality,
shard the pass by `domain` (dimension fan-out). Flagged, not built.

## 6. Confidence — a pure function of state

`confidence` is **not** an incrementally-mutated counter (which would sawtooth against
reinforcement). It is recomputed from stored state:

```
confidence = f(support_count, support_streams, age(last_reinforced), contradiction_count)
```

monotone-increasing in support, decaying with `last_reinforced` age, penalized by
contradictions, clamped to [0,1]. The LLM proposes the *pattern*; the engine owns the
*number*. This sidesteps the LLM-self-rating miscalibration seen in dream-synthesis.

## 7. Creation floor (anti-over-assertion)

Tier B persists a `soft` habit **only** at **≥2 instances across distinct time-spans
AND ≥2 streams.** Below that, nothing is stored.

Consequence: **one TC purchase → no habit.** The "buys gear before trips" pattern
forms only once it repeats across real history (TC before the birding trips + the 20mm
bought *for the astro trip* + the 100-400 era before Death Valley). This is the
guard against the "shooting profile changed dramatically in April" over-read, encoded
in the data path.

## 8. Graduation gate (soft → stated preference)

A `soft` habit becomes `graduated` only when **all measurable** criteria hold:
- `support_count ≥ K` **across ≥2 distinct streams** (no single-stream graduation),
- `confidence ≥` a high floor,
- sustained over **≥ X weeks** (not a one-week spike),
- recency current.

`contradiction_count` is **not** a gate input (we can't measure it reliably); it is a
demotion/retire trigger only.

On graduation the engine **emits a `preferences` `belief_candidate`** into the
*existing* promotion gate (it does **not** write a belief head directly);
`graduated_belief_id` points to it. Until that candidate promotes, even a graduated
habit is rendered hedged.

`K` and `X` are **restart-free policy config** (like `biographer.domainGating`), with
**conservative defaults — graduation is rare by design.**

Retired-suppression is **engine-enforced**, not prompt-trusted: every proposed habit is
embedding-matched against the `retired` set and dropped on collision.

## 9. Personalization wire (Goal A — the payoff)

A habit is useless if Robin can't see it while reasoning. Habits are indexed into the
recall store as a **distinct source**, so the existing `auto-recall` UserPromptSubmit
hook can inject relevant ones per-turn — labeled even softer than memory ("inferred
tendency — hint, not fact").

Two guards so this **augments rather than degrades** recall:
- Habits get a **small dedicated injection budget (top 1–2 relevant, capped)** — they
  never compete with the factual memory block for its limited slots.
- **Sensitive-domain habits require a stricter topical-relevance threshold** to be
  injected at all (so a health/finance pattern never leaks into an unrelated turn).

## 10. Surfacing (Goal B — lowest)

A single optional brief line ("Behavioral note: …"), drawn from `habit.graduated` /
strongly-reinforced events, capped. Not a dashboard. Sensitive domains are excluded
from unprompted surfacing.

## 11. Guardrails

- **Sensitive domains** (health, finance, relationships): stay `soft` permanently —
  **never auto-graduate** and **never surfaced unprompted**; used as quiet, strictly-
  relevant hints only.
- **Self-capture guard:** behavioral signals **exclude Robin's own outputs** — a habit
  is inferred from *Kevin's* actions, never from Robin's recommendations mistaken as
  his. Reuses the existing user-data-dir capture exclusion.
- **Correction = kill switch:** `record_correction` on a habit → `retire` + add to the
  embedding suppression set. A vetoed pattern never returns.
- **Privacy:** habits live in user-data, gitignored, never published.

## 12. Testing

- **Tier A (deterministic):** unit-test the confidence function (monotone in support,
  decays with age, stable retire threshold), exact-entity reinforcement, suppression-match.
- **Tier B (LLM mocked):** golden-fixture signal set → asserts proposed habits,
  retired-not-resurrected, creation-floor enforcement, budget/skip-on-empty.
- **Integration:** cursor advance; `evidence_summary` survives deletion of its source
  events; graduation emits exactly one `preferences` candidate.
- **TC end-to-end fixture (the over-assertion guard):** one gear purchase + one trip →
  **no habit**; three gear-before-trip instances across time → one `soft` habit, **not
  graduated.**

## 13. Open questions / config to settle in the plan

- Concrete defaults for `K` (support), `X` (weeks), the confidence formula constants,
  and the staleness/retire floor — start conservative, tune from the learning-digest.
- Exact `BEHAVIORAL_SIGNAL_KINDS` allowlist enumeration.
- Tier B weekly slot (off-peak; surfacing in the brief is next-brief-eventual, not
  same-night-critical).
- Whether `pattern_kind` is fixed or extensible.

## 14. Build sequence (for the plan)

1. Migration: `habits` table + indexes.
2. `BEHAVIORAL_SIGNAL_KINDS` allowlist + read-time signal normalizer + cursor.
3. Confidence function (pure) + Tier A job (deterministic).
4. Tier B job (LLM synthesis) with creation floor, dedup, suppression, budget.
5. Graduation → `preferences` belief_candidate wiring.
6. Recall-injection source for habits (the Goal-A wire) + sensitive-domain relevance gate.
7. Learning-digest integration + optional brief line.
8. Policy config (`behavior.*`) + tests per §12.
