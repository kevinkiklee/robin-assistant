# Token Budget Governance

This document codifies the rules around the Tier 1 / Tier 2 / Tier 3 layout
that emerged from the 2026-04-29 token-optimization design. Every PR that
touches the always-on instruction layer goes through this gate.

## Budgets

Configured in `system/scripts/lib/token-budget.json`. Currently:

- **Tier 1 total tokens** — ≤5,500 (cache-stable prefix ≤5,300)
- **Tier 1 total lines** — ≤400
- **Per-protocol max tokens** (Tier 2 individual file) — ≤3,000
- **Per-Tier-1-file caps** — declared per-file in `tier1_files`
- **Sub-index caps** — ≤30 lines

Caps are realistic floors, not aspirational targets. They reflect the actual
shape of Kevin's workspace after 12 months of memory; further cuts would
sacrifice findability.

## What requires review

Any change to:

- `AGENTS.md` (Tier 1 root)
- `system/manifest.md`, `system/rules/capture.md`, `system/rules/startup.md`
- `system/jobs/*.md`
- `system/scripts/lib/token-budget.json` (the source of truth)
- `system/scripts/lib/platforms.js` (host pointer files)
- `system/tests/golden-session.snapshot.json`

Routes to a token-budget reviewer (see `CODEOWNERS`).

## CI checks

Running on every PR:

| Check | Failure mode |
|---|---|
| `node system/scripts/measure-tokens.js --check` | Hard fail: any cap exceeded |
| `node system/scripts/lint-memory.js` | Hard fail: orphan files, large unindexed sub-trees, stale INDEX entries |
| `node system/scripts/golden-session.js --check` | Hard fail: Tier 1 load order or stability changed |
| `node system/scripts/regenerate-memory-index.js --check` | Hard fail: INDEX out of date |
| `npm test` | Hard fail: any test |

A PR labeled `tier1-changes` (auto-applied when any Tier 1 file is modified)
gets routed to a budget reviewer in addition to normal review.

## Updating budgets

To raise a cap:

1. Run `node system/scripts/measure-tokens.js` to confirm what the new
   floor is.
2. Edit `token-budget.json`. Add a `$comment` field on the affected entry
   explaining the deviation from the design's original cap.
3. Run `node system/scripts/golden-session.js --update-snapshot` if Tier 1
   structure changed.
4. Add a CHANGELOG entry. Include the old cap, the new cap, and one
   sentence explaining what changed.
5. Open a PR with the `tier1-changes` label.

## Updating the snapshot

To accept new Tier 1 structure:

```sh
npm run golden-session -- --update-snapshot
```

Requires:

- A CHANGELOG entry justifying the change.
- A reviewer who is not the author.

## Adding a new Tier 1 file

Avoid this. Tier 1 should grow only when a host-level requirement changes
(e.g., a new immutable rule). Process:

1. Justify the addition in the PR description.
2. Add the entry to `tier1_files` with `stability` and `max_lines`.
3. Run `npm run golden-session -- --update-snapshot`.
4. Run `npm run measure-tokens` and confirm caps still hold.
5. CHANGELOG entry.

## Adding a new Tier 2 protocol

Less restrictive but still gated:

1. Create `system/jobs/<name>.md`.
2. Confirm `npm run measure-tokens` shows it under the per-protocol cap.
3. Reference it from AGENTS.md's Tier 2 pointer table.
4. CHANGELOG entry.

## Drift detection

`system/jobs/host-validation.md` runs quarterly when enabled. Detects
host-side regressions (e.g., a host stops following Tier 2 pointers).
Failures surface via `state/jobs/failures.md` so the agent mentions them
at session start.

## Escalation

If a Tier 1 cap is repeatedly violated by legitimate work:

1. Document the pattern (3+ PRs hitting the same cap).
2. Re-baseline with the harness (`--update-baseline`).
3. Update this doc with the new cap and rationale.
4. Update the spec at `docs/superpowers/specs/2026-04-29-token-optimization-design.md`
   with a "Revisions" section citing the change.

## Out-of-scope concerns

- **Output streaming** is host-controlled.
- **Per-provider tokenizer fidelity** beyond ~10% is unnecessary; bytes is
  the canonical metric.
- **Quality eval across hosts** is a separate evaluation, not part of this
  budget.
