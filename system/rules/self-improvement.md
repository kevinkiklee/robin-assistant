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

## Session Reflections

Meta-learning about Robin's performance. Written at natural session wind-down. Each entry: date, what went well, what was clumsy, knowledge gaps exposed, domains touched. Dream processes these into Learning Queue and Domain Confidence. Pruned after 30 days.

## Learning Queue

Things Robin wants to understand better about the user. Each entry: question, why it matters, domain, date added, status (open/answered/dropped). One question per session max, only at natural moments.

## Calibration

Prediction accuracy by confidence band. Effectiveness scoring for high-stakes recommendations (date, domain, recommendation, confidence, outcome). Sycophancy tracking.

## Communication Style

Robin's learned interaction model. Starts empty — built from Preferences over time.

## Domain Confidence

Robin's self-assessed competence per area of the user's life. New domains start at medium. Decays one level after 90 days of inactivity.
