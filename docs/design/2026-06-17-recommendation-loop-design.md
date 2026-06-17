# Recommendation→Action Loop (Phase 1) — Design

**Status:** Design (build-approved — follow-up to Phase 2) · **Date:** 2026-06-17

## 1. Motivation

The motivating example: Robin recommended the Nikon Z TC-1.4× one night; Kevin bought
it the next day. Phase 2 (habit inference) will pick up the *purchase* as a behavioral
signal, but nothing records that **Robin recommended it** or links the two. Phase 1
closes that loop: capture Robin's recommendations as first-class records, detect when
Kevin acts, and feed the result into both calibration (Goal C — "which of my advice
lands") and the Phase 2 habit engine (Goal A — e.g. "acts fast on gear recs").

Architecture was settled during the Phase 2 brainstorm: **Approach 2 (first-class
subsystem)**, **Q3-C (explicit ledger + retroactive linker safety net)**, modeled on
the existing `predictions` lifecycle.

## 2. Scope

- **In:** a `recommendations` ledger; an explicit record path (MCP `recommend`); a
  deterministic retroactive **linker** that resolves open recommendations against
  behavioral signals; calibration folded into the learning-digest; feeding acted
  recommendations into the Phase 2 habit engine as a new signal kind.
- **Out (deferred):** the heavier LLM **session-scan backfill** (discovering a
  recommendation Robin never explicitly logged by re-reading transcripts). The
  explicit ledger + deterministic linker deliver the core; the LLM backfill is a
  Phase 1.1 option, noted not built.

## 3. Data model — `recommendations` table

Modeled on `predictions` (claim/confidence/created_at/outcome/resolved lifecycle).

| Field | Purpose |
|---|---|
| `id` | PK |
| `subject` | short canonical name of the recommended thing ("Nikon Z TC-1.4x") — the **match key** for the linker |
| `claim` | the recommendation text/advice |
| `reasoning` | why Robin recommended it |
| `verdict` | optional stance: `buy`\|`skip`\|`wait`\|`try`\|`avoid`\|`other` |
| `domain` | reuses `PERSONAL_DOMAINS` (the calibration-grouping bucket) |
| `confidence` | Robin's confidence in the rec (0..1) |
| `created_at` | — |
| `source_event_id` | where the rec was made (session), `REFERENCES events(id) ON DELETE SET NULL` |
| `expires_at` | optional; after this an unacted rec resolves `not_acted` |
| `status` | `open` \| `acted` \| `declined` \| `expired` \| `superseded` |
| `outcome` | `acted` \| `not_acted` \| `unknown` (mirrors `prediction.outcome`) |
| `acted_at` | when the action was detected |
| `action_event_id` | the behavioral signal/event that fulfilled it, `ON DELETE SET NULL` |
| `evidence` | text: how the link was established (audit, survives event purge) |

Indexes: `(status, expires_at)`, `subject`.

## 4. Capture paths (Q3-C)

1. **Explicit recording** — MCP **`recommend`** (core server, mirroring `predict`):
   `{subject, claim, reasoning?, verdict?, domain, confidence, expiresAt?}` → inserts an
   `open` recommendation tagged with the current `source_event_id`. **`resolve_recommendation`**
   (extension server, mirroring `resolve_prediction`): manually set `outcome` =
   `acted`/`declined` with evidence. Robin logs a recommendation when it makes a
   substantive one (discipline mirrors how it logs predictions).
2. **Retroactive linker** — a nightly deterministic cognition job (`recommendation-link.run`)
   that closes the loop without requiring Robin to have remembered to log perfectly (below).

## 5. The linker — `recommendation-link.run` (nightly, deterministic)

1. Load `open` recommendations.
2. Pull recent behavioral signals (reuse Phase 2's `BEHAVIORAL_SIGNAL_KINDS` +
   `selectNewSignals`, own cursor).
3. **High-precision subject match**: a signal whose `object` exactly/canonically
   matches a recommendation's `subject` (case-insensitive, trimmed, multi-token named
   entity — same conservative rule as Phase 2 Tier A's exact-entity match) resolves it:
   `status=acted`, `outcome=acted`, `acted_at`, `action_event_id`, `evidence`. No fuzzy
   matching (that is the deferred LLM path).
4. **Expiry**: `open` recommendations past `expires_at` → `status=expired`,
   `outcome=not_acted`.
5. **Feed Phase 2**: each newly-acted recommendation **emits a `behavior.recommendation_acted`
   event** (added to `BEHAVIORAL_SIGNAL_KINDS`), so the habit engine can generalize
   ("acts fast on gear recs", "buys gear before trips"). The emitted event carries the
   subject, domain, verdict, and the lag (created_at → acted_at) as a behavioral datum.

Self-capture note: the *recommendation* is Robin's own output (correctly captured here —
that's the point). Only the **acted event** is Kevin's behavior; the habit engine must
treat the `recommendation_acted` signal as Kevin acting, never the recommendation text
as his action.

## 6. Calibration (Goal C)

- The ledger supports an acted-rate view by `domain`/`verdict` ("gear: 8/10 acted;
  restaurant: 1/5"). Folded into the existing **24h learning-digest** alongside the
  prediction-Brier line.
- `resolve_recommendation` lets Kevin/Robin set outcomes the linker can't infer
  (declined, acted-without-a-tracked-purchase).

## 7. Guardrails / config

- Policy (restart-free): `recommendations.enabled` (default true), `recommendations.linkWindowDays`
  (how far back the linker scans, default e.g. 60), `recommendations.defaultExpiryDays`
  (default expiry for recs with no explicit `expires_at`, e.g. 90).
- Privacy: ledger in user-data, gitignored.
- Domain gating: recommendations carry a `PERSONAL_DOMAINS` domain; sensitive-domain
  recommendations (health/finance) are never surfaced unprompted (consistent with Phase 2).

## 8. Testing

- Store CRUD; explicit record + resolve.
- Linker: an open rec + a matching behavioral signal → acted (with action_event_id +
  evidence); a non-matching signal → stays open; an open rec past expiry → expired/not_acted;
  a newly-acted rec emits exactly one `behavior.recommendation_acted` event.
- The TC end-to-end: record `recommend(subject="Nikon Z TC-1.4x", verdict=buy)` →
  feed a matching purchase signal → linker marks it acted and emits the signal.
- Calibration digest fold.

## 9. Build sequence

1. Migration: `recommendations` table + indexes.
2. Types + store (CRUD + subject-match helper) + `behavior.recommendation_acted` added to
   `BEHAVIORAL_SIGNAL_KINDS`.
3. MCP `recommend` (core) + `resolve_recommendation` (extension).
4. `recommendation-link.run` linker job + registration + policy config.
5. Calibration digest fold.
6. Tests per §8.
