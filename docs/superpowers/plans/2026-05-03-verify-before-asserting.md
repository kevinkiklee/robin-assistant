# Verify-before-asserting systematization — Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development. Tasks use `- [ ]` syntax.

**Spec:** `docs/superpowers/specs/2026-05-03-verify-before-asserting-design.md` — read before any task.

**Goal:** Three independent components: domain-trigger recall, freshness contract, derived-source dampening.

---

## File Structure

### New
| Path | Responsibility |
|---|---|
| `system/scripts/lib/freshness.js` | stampLastSynced / isFresh / getLastSynced. Atomic frontmatter helpers. |
| `system/scripts/diagnostics/check-sync-freshness.js` | Scan synced files; report missing/stale `last_synced`. |
| `system/scripts/diagnostics/check-derived-tagging.js` | Lint `[fact|origin=<derived-source>]` violations; CI gate. |
| `system/scripts/hooks/lib/domain-recall.js` | Load recall-domains.md; build map; word-boundary match; return injection list. |
| `system/scaffold/runtime/config/recall-domains.md` | Default domain map. |
| `system/migrations/0028-add-recall-domains.js` | Copy scaffold → user-data on install. Idempotent. |
| `system/tests/lib/freshness.test.js` | Helper tests. |
| `system/tests/hooks/domain-recall.test.js` | Parser, match, dedup. |
| `system/tests/diagnostics/check-sync-freshness.test.js` | Fixture mix; report. |
| `system/tests/diagnostics/check-derived-tagging.test.js` | Violations + allow comment; exit code. |
| `system/tests/migrate/migration-0028-recall-domains.test.js` | Copy + idempotency. |
| `system/tests/e2e/hooks/onUserPromptSubmit-domain-recall-injection.test.js` | "fertilizer" → garden file injected. |
| `system/tests/e2e/hooks/onUserPromptSubmit-domain-no-double-inject.test.js` | Entity + domain both match → injected once. |
| `system/tests/e2e/hooks/onUserPromptSubmit-domain-empty-map.test.js` | Empty map → entity recall still fires. |
| `system/tests/e2e/jobs/dream-stale-sync-flag.test.js` | Stale `last_synced` → flagged in needs-your-input.md. |

### Modified
| Path | Change |
|---|---|
| `system/scripts/hooks/claude-code.js` | onUserPromptSubmit calls domain-recall; merges/dedups with entity recall; recall.log gains `source` field. |
| `system/rules/capture.md` | Add "Derived sources (low trust for identity claims)" subsection. |
| `CLAUDE.md` | Two operational rules: freshness check before quoting synced data; derived-source identity dampening. |
| `system/jobs/dream.md` | Phase 11.5: count domain-trigger vs entity recalls; flag dead keywords. Phase 12.5 (or new step): stale-sync-files section. |
| `package.json` | Add `check-sync-freshness` and `check-derived-tagging` scripts. |
| `.github/workflows/tests.yml` | Add `check-derived-tagging` step to `unit` job. |
| `CHANGELOG.md` | Unreleased entry. |

### Out-of-scope (in package; documented for user-data follow-up)
| Path | Change (in user-data, not package) |
|---|---|
| `user-data/runtime/scripts/sync-*.js` | One-time pass to call `stampLastSynced` after each successful write. Listed in spec. |

---

## Phases

### Phase 1 — Freshness helpers + diagnostics
- [ ] Implement `freshness.js`.
- [ ] Implement `check-sync-freshness.js`.
- [ ] Implement `check-derived-tagging.js`.
- [ ] Add scripts to `package.json`.
- [ ] Wire `check-derived-tagging` into CI (`.github/workflows/tests.yml`).
- [ ] Unit tests for all three.
- Acceptance: `npm run check-sync-freshness` and `npm run check-derived-tagging` run cleanly; CI workflow updated.

### Phase 2 — Capture rule update
- [ ] Add "Derived sources (low trust for identity claims)" subsection to `system/rules/capture.md`.
- [ ] Add CLAUDE.md operational rule referencing it.
- Acceptance: rule documented and load-bearing.

### Phase 3 — Domain-recall extension
- [ ] Implement `domain-recall.js`.
- [ ] Ship `system/scaffold/runtime/config/recall-domains.md` with sensible defaults.
- [ ] Implement migration 0028 (copy scaffold to user-data).
- [ ] Extend `claude-code.js` onUserPromptSubmit to call domain-recall after entity scan; dedup; merge into single `<!-- relevant memory -->` block.
- [ ] Update recall.log entries with `source` field.
- [ ] Unit + e2e tests.
- Acceptance: domain matches inject expected files; entity-only paths unchanged.

### Phase 4 — Freshness CLAUDE.md + Dream
- [ ] Add CLAUDE.md operational rule for freshness check before quoting synced data.
- [ ] Update Dream Phase 11.5 (domain vs entity recall counts; dead-keyword flag) and Phase 12.5 (stale-sync-files section in needs-your-input.md).
- [ ] Pre-merge: `npm run measure-tokens` on dream.md.
- [ ] Implement `dream-stale-sync-flag.test.js`.
- Acceptance: freshness rule documented; Dream surfaces stale syncs.

### Phase 5 — Verification baselines + CHANGELOG
- [ ] Run `npm run check-sync-freshness` against current state (spot-check; baseline informs follow-up).
- [ ] Run `npm run check-derived-tagging` against current state. Fix violations OR add `# allow-derived-fact: pre-existing` comments. Document baseline in CHANGELOG.
- [ ] CHANGELOG entry.
- [ ] `npm test` green.
- Acceptance: clean working tree, tests green, baselines recorded.

---

## Pre-merge verifications (from spec)

1. Run `check-sync-freshness` against current state. Establish baseline.
2. Run `check-derived-tagging` against current state. Establish baseline.
3. Verify domain-recall doesn't blow up `bytesInjected` (spot-check `recall.log`).
4. Re-measure dream.md token count.

---

## Coordination notes

- Depends on thread #3's `needs-your-input.md` infrastructure for the stale-sync-files section. Implement #3 first OR coordinate the appendSection call in this thread to use the same helper.
- CLAUDE.md operational rules section will accumulate notes from this thread + #1 + #3 + #5. Keep organized.
