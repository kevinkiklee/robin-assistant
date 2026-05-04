---
name: recall-telemetry-review
dispatch: inline
model: sonnet
triggers: []
description: Dream sub-pass — analyze recall.log; surface findings to needs-your-input.md. Called from Dream Phase 11.5.
runtime: agent
enabled: false
---
# Protocol: Recall telemetry review

Sub-pass invoked by Dream Phase 11.5. Not a standalone protocol — has no
trigger phrases.

## Input

`user-data/runtime/state/recall.log` — TSV with one row per turn that
emitted a `<!-- relevant memory -->` block. Columns:

```
ts \t sessionId \t labels \t hitsInjected \t bytesInjected \t source
```

`labels` is comma-joined; entity labels are bare names, domain labels are
prefixed `domain:<name>`. `source` is one of `entity` | `domain` |
`entity+domain`. Rows missing the `source` column predate the schema
extension and are treated as `entity` for backward compat.

## Window

Read rows since `last_dream_at` (from `dream-state.md`). For dead-keyword
analysis, expand to 60 days.

## Findings to surface

Append to `needs-your-input.md` under `Recall telemetry` via `appendSection`
(`system/scripts/lib/needs-input.js`). Compose a single markdown body
covering each present signal; omit empty signals so the section stays
focused.

1. **Injection-bytes trend.** Compute avg `bytesInjected` for this window
   vs the prior equal-length window. Flag if rising >2×. Ignore turns with
   bytes=0.
2. **Entities matched but routed to nothing.** Group by entity label.
   Entities matched ≥3 times this window with all rows showing `hits=0` →
   suggest creating a topic file (the entity name is recognized but no
   memory backs it).
3. **Aliases skipped due to missing disambiguator.** Read
   `user-data/runtime/state/cache/recall-skipped.log` if present
   (one entry per skipped ambiguous match). Group; list top 5 for backfill.
4. **Domain-trigger firings.** Filter rows where `source` is `domain` or
   `entity+domain`; extract `domain:<name>` labels. For each domain
   declared in `user-data/runtime/config/recall-domains.md`:
   - Fired ≥1 time in last 60d → silent (working as intended).
   - Fired 0 times in last 60d → list as dead-keyword cleanup signal so
     the user can prune or broaden the keyword set.

## Output format

Compose one body for `appendSection(workspaceDir, 'Recall telemetry', body)`.
Lead with the most actionable finding; trailing items are nice-to-have.
If no findings warrant surfacing, call `clearSection(workspaceDir,
'Recall telemetry')` instead.

Errors during analysis are non-fatal — log to dream output and continue;
do not abort the cycle.
