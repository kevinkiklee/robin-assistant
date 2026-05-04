# Self-Improvement Rules

How Robin processes self-improvement data. The user-facing log lives under `user-data/memory/self-improvement/` as a directory of subtopic files (`corrections.md`, `preferences.md`, `session-handoff.md`, `calibration.md`, `communication-style.md`, `domain-confidence.md`, `learning-queue.md`, `predictions.md`, `action-trust.md`). Each section described below maps to its own file in that directory.

## Corrections

When the user corrects Robin, append an entry to `## Corrections`. Capture: what was wrong, what to do instead, date, domain (if applicable). Append-only.

## Patterns

Recurring corrections (3+ similar) get promoted to named patterns by Dream. Each pattern includes: recognition signals (what triggers the failure mode), counter-actions (what to do instead), supporting correction IDs. Patterns may be retired by Dream when they stop firing.

## Preferences

Positive signals and explicit style feedback go here. Each entry: what worked, domain (or "general"), summarized evidence, date. Domain-specific entries override general ones. Dream promotes stable preferences (3+ signals) to Communication Style.

## Session Handoff

Rolling notes for the next session. Newest entry at top. The capture sweep writes a brief summary here at session end: "Captured N items to inbox (breakdown by tag). [Any context the next session needs]."

## Learning Queue

Things Robin wants to understand better about the user. Lifecycle owned by Dream (`system/jobs/learning-queue.md`):

- **Population** — Dream scans `inbox.md` (`[?|...]`), session-handoff capture summaries, recent corrections, and journal entries for knowledge gaps. Promotes worthy ones to a new `### YYYY-MM-DD — Title` block with `qid:`, `domain:`, `why:`, `status: open`, `added:`.
- **Selection + surfacing** — Dream picks one question per day by score (+2 exact `domain:` match against last 24h of captures, +1 keyword overlap ≥2 non-stopword tokens; oldest `added:` then qid lexical as tiebreakers) and writes it to `user-data/runtime/state/learning-queue/today.md`. CLAUDE.md startup #4 reads it.
- **In-session ask** — when `today.md` is non-empty and a natural moment arises (topic match, lull, end of low-stakes exchange), the model asks the question. If the user dismisses or signals "not now," the model does NOT re-ask the same question this session.
- **Closure** — when the user answers substantively, capture as `[answer|qid=<qid>|<original-tag>|origin=user] <answer>` to inbox. Next Dream run promotes the answer to its destination (preferences/decisions/corrections/profile/knowledge), flips `status: answered`, and clears `today.md` if its qid matches.
- **Retire** — open questions older than 60 days flip to `status: dropped` with `dropped_reason: "stale, never answered"`.

## Calibration

Prediction accuracy by confidence band. Effectiveness scoring for high-stakes recommendations (date, domain, recommendation, confidence, outcome). Sycophancy tracking.

## Communication Style

Robin's learned interaction model. Starts empty — built from Preferences over time.

## Domain Confidence

Robin's self-assessed competence per area of the user's life. New domains start at medium. Decays one level after 90 days of inactivity.
