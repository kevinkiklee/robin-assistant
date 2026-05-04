# Action-trust closing-the-loop — Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development. Tasks use `- [ ]` syntax.

**Spec:** `docs/superpowers/specs/2026-05-03-action-trust-closing-the-loop-design.md` — read before any task.

**Goal:** Make Dream's pending-review output a real persistent file; surface at session start; add CLI for review.

---

## File Structure

### New
| Path | Responsibility |
|---|---|
| `system/scripts/cli/trust.js` | CLI subcommand handler: status / pending / history / class. Pure read. |
| `system/scripts/diagnostics/check-action-captures.js` | Scan inbox.md for `[action]` lines; report counts. |
| `system/scripts/lib/needs-input.js` | appendSection / clearSection / clearFile / readSections for needs-your-input.md. |
| `system/tests/lib/needs-input.test.js` | Helper tests. |
| `system/tests/cli/trust.test.js` | Each subcommand against fixtures. |
| `system/tests/diagnostics/check-action-captures.test.js` | Counts against fixtures. |
| `system/tests/e2e/jobs/action-trust-promotion.test.js` | Phase 12.5 emits proposal to needs-your-input.md. |
| `system/tests/e2e/jobs/action-trust-auto-finalize.test.js` | 24h+ proposal, no objection → AUTO; closed entry; needs-your-input cleared. |
| `system/tests/e2e/jobs/action-trust-promotion-rejected.test.js` | `[correction] reject promotion <id>` → cancel; class stays ASK. |
| `system/tests/e2e/jobs/action-trust-demotion-on-correction.test.js` | `corrected` outcome → AUTO→ASK. |
| `system/tests/e2e/jobs/action-trust-probation-clear.test.js` | Probation expired, 0 corrections → flag cleared. |
| `system/tests/e2e/jobs/action-trust-90d-decay.test.js` | 90d idle AUTO → ASK. |
| `system/tests/e2e/jobs/action-trust-capture-warning.test.js` | Zero `[action]` in 7d → warning section. |
| `system/tests/e2e/hooks/needs-your-input-startup-load.test.js` | Non-empty file → CLAUDE.md startup reads it. |

### Modified
| Path | Change |
|---|---|
| `bin/robin.js` | Register `trust` subcommand. |
| `system/jobs/dream.md` | Replace "escalation report" refs in phases 8/11.5/12.5/18 with explicit writes to needs-your-input.md. Phase 0 (new): clear resolved sections. Phase 12.5: capture-pipeline-check sub-step. Pre-merge: re-measure tokens. |
| `CLAUDE.md` | Startup #4 append needs-your-input.md (LAST). Two operational rules notes. |
| `package.json` | Add `check-action-captures` script. |
| `CHANGELOG.md` | Unreleased entry. |

---

## Phases

### Phase 1 — Helpers + CLI
- [ ] Implement `needs-input.js` (all four exports).
- [ ] Implement `trust.js` CLI handler with all four subcommands.
- [ ] Wire `trust` into `bin/robin.js`.
- [ ] Unit tests for both.
- Acceptance: `node bin/robin.js trust` runs against fixture; `npm test:unit` green.

### Phase 2 — Capture diagnostic
- [ ] Implement `check-action-captures.js`.
- [ ] Wire into `package.json` scripts.
- [ ] Unit tests against fixture inbox.
- Acceptance: `npm run check-action-captures` runs cleanly.

### Phase 3 — Dream protocol updates
- [ ] Replace "escalation report" in phases 8, 11.5, 12.5, 18 with explicit writes via `needs-input.js`.
- [ ] Add Phase 0 (clear resolved items) at start of Dream.
- [ ] Add capture-pipeline-check sub-step in Phase 12.5: ≥7 days zero captures → append warning to needs-your-input.md.
- [ ] Pre-merge: `npm run measure-tokens` on dream.md.
- Acceptance: token cap respected.

### Phase 4 — CLAUDE.md updates
- [ ] Append needs-your-input.md to startup #4 (LAST, alongside today.md from learning-queue thread).
- [ ] Add operational rules note: "When non-empty, surface its items in first response; promotions auto-finalize 24h."
- [ ] Add operational rules note about `[action]` captures being load-bearing.
- Acceptance: CLAUDE.md updated.

### Phase 5 — E2E scenarios
- [ ] Implement all 8 e2e scenarios.
- [ ] Each scenario uses existing harness; fixtures under `system/tests/fixtures/jobs/...`.
- Acceptance: `npm run test:e2e` green.

### Phase 6 — CHANGELOG + final verification
- [ ] CHANGELOG entry.
- [ ] `npm test` green.
- [ ] `npm run check-action-captures` against current state — surface as Dream input on next run.
- Acceptance: clean working tree, tests green.

---

## Pre-merge verifications (from spec)

1. Re-measure dream.md after Phase 0 + capture-check additions.
2. Verify needs-your-input.md placement at end of CLAUDE.md startup doesn't disrupt cache.
3. Run `check-action-captures` against current state.

---

## Coordination notes

- This thread depends on shared CLAUDE.md startup #4 ordering with thread #5 (learning queue today.md). Both files go LAST. Apply both in same edit if implementing simultaneously, or ensure ordering preserved if sequential.
- Dream Phase 0 (new) must run before existing Phase 12.5 calibration step.
