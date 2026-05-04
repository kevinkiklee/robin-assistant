# Pre-protocol hard-assertion hook — Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development. Tasks use `- [ ]` syntax.

**Spec:** `docs/superpowers/specs/2026-05-03-pre-protocol-assertion-hook-design.md` — read before any task.

**Goal:** Mechanically prevent the model from invoking a protocol without reading its user-data override.

---

## File Structure

### New
| Path | Responsibility |
|---|---|
| `system/scripts/lib/protocol-trigger-match.js` | `loadTriggerMap(repoRoot)`, `findMatchingProtocols(promptText, triggerMap)`. Built on `protocol-frontmatter.js`. |
| `system/scripts/hooks/lib/protocol-override-state.js` | Per-session state I/O at `<workspace>/user-data/runtime/state/protocol-overrides/<session_id>.json`. Atomic writes. |
| `system/scripts/diagnostics/check-protocol-triggers.js` | Lint: error if a protocol file is missing `triggers:`. Empty `[]` is valid opt-out. |
| `system/tests/lib/protocol-trigger-match.test.js` | Frontmatter + match + 3 precedence cases. |
| `system/tests/hooks/protocol-override-state.test.js` | Atomic writes, stale-mtime, multi-session isolation. |
| `system/tests/diagnostics/check-protocol-triggers.test.js` | Missing/empty triggers behavior. |
| `system/tests/jobs/dream-hook-enforcement-review.test.js` | Phase 3 aggregation, ≥2 threshold, append to corrections.md. |
| `system/tests/e2e/hooks/protocol-override-injection.test.js` | UserPromptSubmit injects when trigger fires + override exists. |
| `system/tests/e2e/hooks/protocol-override-no-false-positive.test.js` | "the daily briefing system" does NOT match. |
| `system/tests/e2e/hooks/protocol-override-block-system-read.test.js` | PreToolUse blocks system Read. |
| `system/tests/e2e/hooks/protocol-override-allow-after-override-read.test.js` | Read user-data first then system → both allowed. |
| `system/tests/e2e/hooks/protocol-override-no-trigger-no-block.test.js` | Read system without trigger → not blocked. |
| `system/tests/e2e/hooks/protocol-override-no-override-no-block.test.js` | Trigger fires for protocol with no override → not blocked. |
| `system/tests/e2e/hooks/protocol-override-stale-state.test.js` | mtime >24h → no state, allow. |
| `system/tests/e2e/hooks/protocol-override-cross-turn-clears.test.js` | Verifies always-overwrite. |
| `system/tests/e2e/hooks/protocol-override-fail-open.test.js` | Corrupt state → log hook_error, allow. |
| `system/tests/e2e/hooks/protocol-override-state-write-failure.test.js` | Write fails → delete attempt; PreToolUse allows. |
| `system/tests/e2e/hooks/protocol-override-user-only-protocol.test.js` | User-only protocol → injection still emitted. |
| `system/tests/e2e/hooks/protocol-override-trigger-overlap.test.js` | Two protocols share trigger → both fire. |

### Modified
| Path | Change |
|---|---|
| `system/scripts/hooks/claude-code.js` | Extend `onUserPromptSubmit` (always-overwrite state, conditional inject) + `onPreToolUse` (Read enforcement). |
| `system/jobs/dream.md` | Phase 3 gains "Hook enforcement review" + Phase 4 gains state-file orphan cleanup. |
| `system/jobs/weekly-review.md` | Add "Hook enforcement summary" section. |
| `system/jobs/{_robin-sync,audit,backup,migrate-auto-memory,outcome-check,watch-topics}.md` | Add `triggers: []`. |
| `CLAUDE.md` | Operational rules note about hook. |
| `.github/workflows/tests.yml` | Add `npm run check-protocol-triggers` to `unit` job. |
| `package.json` | Add `check-protocol-triggers` script. |
| `CHANGELOG.md` | Unreleased entry. |

---

## Phases

### Phase 1 — Helpers + lint + tests for both
- [ ] Implement `protocol-trigger-match.js` with `loadTriggerMap` + `findMatchingProtocols`. Reuse `protocol-frontmatter.js`.
- [ ] Implement `protocol-override-state.js` (read/write/atomic-rename/mtime-check).
- [ ] Implement `check-protocol-triggers.js` lint.
- [ ] Add `triggers: []` to the 6 scheduled-only protocols.
- [ ] Wire `check-protocol-triggers` into `package.json` scripts and `.github/workflows/tests.yml`.
- [ ] Unit tests for all three helpers; verify lint passes against current protocol set.
- Acceptance: `npm test` green; lint passes; CI workflow updated.

### Phase 2 — Hook extensions
- [ ] Extend `onUserPromptSubmit` in `claude-code.js`: always-overwrite state + conditional inject. Use canonical injection text from spec.
- [ ] Extend `onPreToolUse`: Read enforcement with `POLICY_REFUSED [protocol-override:must-read-user-data]: ...` and `exit(2)`.
- [ ] Append JSONL telemetry per spec schema.
- [ ] State-write failure → delete attempt path.
- Acceptance: existing hook tests stay green; new hooks behavior covered by Phase 3 e2e tests.

### Phase 3 — E2E scenarios
- [ ] Implement all 11 e2e scenarios listed in File Structure above.
- [ ] Each scenario uses the existing harness; fixtures under `system/tests/fixtures/hooks/...`.
- [ ] Verify edge cases: stale state, cross-turn clear, fail-open, user-only protocol, trigger overlap.
- Acceptance: `npm run test:e2e` green.

### Phase 4 — Dream + CLAUDE.md updates
- [ ] Add Phase 3 hook-enforcement-review step to `dream.md`. Threshold ≥2 → corrections.md append; hook_error → notable.
- [ ] Add Phase 4 state-file orphan cleanup step.
- [ ] Add weekly-review hook-enforcement-summary section.
- [ ] Add CLAUDE.md operational rules note.
- [ ] Pre-merge gate: run `npm run measure-tokens` to confirm dream.md fits per-protocol cap. If over, split into separate `system/jobs/hook-enforcement-review.md` job and have Dream call it.
- [ ] Implement `dream-hook-enforcement-review.test.js`.
- Acceptance: token cap respected; tests green.

### Phase 5 — CHANGELOG + final verification
- [ ] CHANGELOG entry.
- [ ] `npm test` green.
- [ ] `npm run check-protocol-triggers` exits 0.
- [ ] Dry-run `git diff` review for unintentional changes.
- [ ] Single commit per phase OR squashed per-PR (commit cadence at implementer's discretion).
- Acceptance: clean working tree, tests green.

---

## Pre-merge verifications (from spec)

1. Verify Claude Code hook serialization assumption against current docs.
2. Verify UserPromptSubmit injection mechanism (return contract for the planned `<system-reminder>` shape).
3. Re-measure dream.md token count; split into separate job if over cap.
