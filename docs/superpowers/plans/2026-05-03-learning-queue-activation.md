# Learning-queue activation — Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development. Tasks use `- [ ]` syntax.

**Spec:** `docs/superpowers/specs/2026-05-03-learning-queue-activation-design.md` — read before any task.

**Goal:** Fix the 3-layer breakage (population, surfacing, closure) by making Dream the daily owner.

---

## File Structure

### New
| Path | Responsibility |
|---|---|
| `system/scripts/lib/learning-queue.js` | Helpers: loadQueue, qidFromHeading (collision suffix), pickToday, writeToday, clearToday, readToday, markAnswered, retireStale, routeFromTag. |
| `system/scaffold/runtime/state/learning-queue/.gitkeep` | Directory exists at install. |
| `system/migrations/0027-add-qids-to-learning-queue.js` | Backfill qid on existing entries. Idempotent. |
| `system/tests/lib/learning-queue.test.js` | Unit tests for all helpers. |
| `system/tests/migrate/migration-0027-add-qids.test.js` | Backfill + idempotency. |
| `system/tests/e2e/jobs/learning-queue-population.test.js` | Inbox `[?]` items → new queue entries. |
| `system/tests/e2e/jobs/learning-queue-selection.test.js` | Recent captures match domain → that question becomes today.md. |
| `system/tests/e2e/jobs/learning-queue-closure.test.js` | `[answer|qid=...]` → marked answered + routed + today.md cleared. |
| `system/tests/e2e/jobs/learning-queue-empty.test.js` | Empty queue → no today.md. |
| `system/tests/e2e/jobs/learning-queue-stale-retire.test.js` | 61d unanswered → dropped. |
| `system/tests/e2e/jobs/learning-queue-stale-today-cleanup.test.js` | today.md mtime >48h → Dream Phase 4 deletes. |

### Modified
| Path | Change |
|---|---|
| `system/jobs/dream.md` | Replace Steps 7+10 with unified "Learning queue daily maintenance"; Phase 4 stale today.md cleanup. Pre-merge: re-measure tokens. |
| `system/rules/self-improvement.md` | Update Learning Queue section. Drop Session Reflections paragraph. |
| `CLAUDE.md` | Startup #4 append today.md (LAST in list). Operational rules note. |
| `system/scaffold/memory/self-improvement/learning-queue.md` | Schema example shows `qid:`. |
| `CHANGELOG.md` | Unreleased entry. |

---

## Phases

### Phase 1 — Helpers + migration
- [ ] Implement `learning-queue.js` with all exported helpers.
- [ ] Implement migration 0027 to backfill qids on existing entries.
- [ ] Unit tests for helpers + migration test.
- Acceptance: `npm test:unit` green.

### Phase 2 — Dream protocol rewrite
- [ ] Rewrite Step 7 + Step 10 of `dream.md` as unified "Learning queue daily maintenance" with 5 phases (population/selection/surfacing/closure/retire).
- [ ] Add Phase 4 stale today.md cleanup step.
- [ ] Drop dangling `## Session Reflections` reference.
- [ ] Update `system/rules/self-improvement.md`: new mechanism description, drop Session Reflections paragraph.
- [ ] Pre-merge: `npm run measure-tokens` — if over per-protocol cap, split into `system/jobs/learning-queue.md` agent job; Dream invokes it.
- Acceptance: token cap respected; protocol tests green.

### Phase 3 — CLAUDE.md + scaffold
- [ ] Append today.md path to CLAUDE.md startup #4 (LAST in read list).
- [ ] Add operational rules note about asking when natural + capturing answer with `[answer|qid=...]`.
- [ ] Update scaffold learning-queue.md schema example.
- [ ] `system/scaffold/runtime/state/learning-queue/.gitkeep`.
- Acceptance: scaffold installs cleanly.

### Phase 4 — E2E scenarios
- [ ] Implement all 6 e2e scenarios.
- [ ] Each scenario uses existing harness; fixtures under `system/tests/fixtures/jobs/...`.
- Acceptance: `npm run test:e2e` green.

### Phase 5 — CHANGELOG + final verification
- [ ] CHANGELOG entry.
- [ ] `npm test` green.
- [ ] Spot-check `cache_creation_input_tokens` impact of today.md placement (per spec gate 2).
- Acceptance: clean working tree, tests green.

---

## Pre-merge verifications (from spec)

1. Re-measure dream.md after rewrite; split if over cap.
2. Confirm today.md placement at end of CLAUDE.md startup #4 doesn't disrupt cache.
