# Token Optimization & Frontier-Model Reliability Design

**Date:** 2026-04-29
**Author:** Kevin (with Claude)
**Status:** Draft — awaiting user review
**Scope:** Reduce per-session token cost across `robin-assistant` without sacrificing correctness, while improving performance and reliability. Frontier-only host targets.

---

## 1. Goals & non-goals

### Goals
- Cut Tier-1 always-on token cost by ≥50% (target ≤5,000 Anthropic-tokenized tokens / ≤250 lines).
- Maintain functional parity (Q2 = B): same capabilities, exact outputs may shift, redundant rules may be merged.
- Keep prompt cache hit rate high — stable static prefix, volatile content moved to the tail.
- Improve session-start performance: retire avoidable subprocess spawns.
- Improve reliability: simpler capture rule, atomic writes, lint-enforced caps, idempotent migrations.
- Add memory-pruning lifecycle so storage and INDEX size remain bounded over years.

### Non-goals
- Strict behavior parity (Q2 = A) — out of scope; we accept output evolution.
- Output streaming or host-level rendering optimizations.
- Per-provider tokenizer fidelity beyond ~10%.
- Quality evaluation across hosts (separate eval).

### Constraints
- Frontier-only model targets: Opus 4.7, GPT-5.5, Gemini Pro 3.1 (and successors of equivalent capability).
- Five hosts only: Claude Code, Cursor, Codex, Gemini CLI, Antigravity. Windsurf removed.
- All persistent memory under `user-data/`; immutable Privacy / Verification / Local-Memory / Time rules untouched.

---

## 2. Tiered loading architecture

Three tiers governed by stability and frequency of access. Cache layout: **frozen → slow → volatile**.

### Tier 1 — always-on, cache-stable prefix (target ≤250 lines, ≤5,000 tokens)

Loaded every session, in this declared order:

1. `AGENTS.md` (~50 lines, down from 120)
2. `user-data/robin.config.json` (small — name, timezone, assistant name)
3. `user-data/memory/profile/identity.md` (cap 100 lines)
4. `user-data/memory/profile/personality.md` (cap 100 lines)
5. `user-data/memory/INDEX.md` (cap 40 lines)
6. `user-data/integrations.md`
7. `user-data/custom-rules.md` (if exists)
8. `user-data/memory/self-improvement/communication-style.md` (~20 lines, stable)
9. `user-data/memory/self-improvement/domain-confidence.md` (~20 lines, stable)
10. `user-data/memory/hot.md` (cap 60 lines, volatile)
11. `user-data/memory/self-improvement/session-handoff.md` (~15 lines, volatile)
12. `user-data/memory/self-improvement/learning-queue.md` (~5 lines, volatile)
13. `user-data/state/sessions.md` (volatile)
14. `user-data/state/jobs/failures.md` (volatile)

Tier 1 contains:
- The 5-line capture checkpoint (so capture works even if Tier 2 fails to load).
- Immutable rules (Privacy, Verification, Local Memory, Time).
- The Tier 2 pointer table.
- Identity + personality (Robin must always know who Kevin is).

### Tier 2 — on-demand, fetched by Tier 1 pointer

| File | Purpose |
|---|---|
| `system/manifest.md` | Path catalog |
| `system/rules/capture.md` | Full capture vocabulary, routing table, sweep |
| `system/rules/startup.md` | First-run + edge cases (sequence collapsed into AGENTS.md) |
| `system/jobs/*.md` | Protocols (12 today) |
| `system/rules/self-improvement.md` | Correction processing |
| `user-data/memory/LINKS.md` | Cross-reference graph |
| `user-data/memory/self-improvement/corrections.md` | Historical corrections |
| `user-data/memory/self-improvement/preferences.md` | Captured preferences |
| `user-data/memory/self-improvement/calibration.md` | Calibration log |

Fetched explicitly via the agent's `Read` tool when Tier 1 pointers direct.

### Tier 3 — cold storage, accessed by path

| Path | Access pattern |
|---|---|
| `knowledge/finance/lunch-money/transactions/<month>.md` | By date |
| `knowledge/finance/lunch-money/INDEX.md` | Sub-index for the lunch-money tree |
| `knowledge/photography-collection/INDEX.md` | Sub-index for photo collection |
| `knowledge/events/INDEX.md` | Sub-index for events |
| `user-data/memory/archive/` + `archive/INDEX.md` | Pruned content (Section 7) |

Each Tier-3 sub-tree gets its own INDEX so the main INDEX stays under 40 lines.

### Invariants

- **I1.** Capture checkpoint is always reachable from Tier 1 (5-line rule in AGENTS.md).
- **I2.** Identity + personality are always loaded.
- **I3.** Hard rules (Privacy, Verification, Time, Precedence) are always loaded.
- **I4.** Tier 2 fetches are explicit by path — no hand-wavy "look around."
- **I5.** Cache order is frozen → slow → volatile. Lint-enforced.
- **I6.** Tier 1 sum ≤ 5,000 tokens. Lint-enforced (CI hard fail).
- **I7.** `archive/INDEX.md` is reachable via a Tier 1 pointer (otherwise archived data is unreachable).

---

## 3. File-by-file changes

### Tier 1 changes

| File | Today | Target | Change |
|---|---|---|---|
| `AGENTS.md` | 120 lines | ~50 | Drop Workspace Layout table, Protocols table, redundant Session Startup; add 5-line capture checkpoint, Tier-2 pointer table |
| `user-data/memory/INDEX.md` | 90 lines | ≤40 | Move high-churn sub-trees to sub-indexes |
| `hot.md` | 75 cap | ≤60 | Cap 2 sessions × 30 lines |
| `profile/identity.md`, `personality.md` | varies | ≤100 each | Lint cap |
| **NEW** `self-improvement/communication-style.md`, `domain-confidence.md`, `session-handoff.md`, `learning-queue.md` | — | small | Split from monolith |

### Tier 2 changes

| File | Today | Target | Change |
|---|---|---|---|
| `system/manifest.md` | 117 | ~60 | Trim catalog; drop tables now in AGENTS.md |
| `system/rules/capture.md` | 279 | ~120 | Reorganize; drop redundant examples; Tier 1 keeps 5-line decision rule |
| `system/rules/startup.md` | 40 | ~15 | Sequence collapses into AGENTS.md; keep first-run + edge cases |
| `system/jobs/*.md` (12 files) | 37–134 | 30–40% lighter | Wording pass; common preamble extracted |
| **NEW** `self-improvement/corrections.md`, `preferences.md`, `calibration.md` | — | per-topic | Split from monolith |

### Tier 3 additions

| Path | Purpose |
|---|---|
| `knowledge/finance/lunch-money/INDEX.md` | Replace 35+ rows in main INDEX |
| `knowledge/photography-collection/INDEX.md` | 7 files |
| `knowledge/events/INDEX.md` | 6+ events |
| `user-data/memory/archive/` | Pruned content tree |
| `user-data/memory/archive/INDEX.md` | Cold-storage catalog (one row per archived bucket) |

### Files removed

- `.windsurfrules` template + scaffolding (Windsurf out)
- `.cursorrules` template (Cursor reads AGENTS.md natively as of 2026)
- All `windsurf` references in tests, docs, README, CHANGELOG

### `system/scripts/lib/platforms.js` updated

```js
const POINTER = 'Read and follow AGENTS.md for all instructions.\nAfter every response, scan for capturable signals and write to user-data/memory/inbox.md with tags.\n';

export const PLATFORMS = {
  'claude-code': { pointerFile: 'CLAUDE.md', pointerContent: POINTER },
  'cursor':      { pointerFile: null, pointerContent: null },
  'gemini-cli':  { pointerFile: 'GEMINI.md', pointerContent: POINTER },
  'codex':       { pointerFile: null, pointerContent: null },
  'antigravity': { pointerFile: null, pointerContent: null },
};
```

`regenerate-pointers.js` deletes any leftover `.windsurfrules`/`.cursorrules`.

### Migrations

Numbered in execution order so they run in dependency order at startup.

| # | Purpose | Idempotent | Reversible |
|---|---|---|---|
| 0008 | Split `self-improvement.md` → `self-improvement/{section}.md` | ✓ | ✓ (concat back) |
| 0009 | Generate sub-indexes; reflow main INDEX | ✓ | ✓ |
| 0010 | Initial archive scaffolding (`archive/` + `archive/INDEX.md`) | ✓ | ✓ |
| 0011 | Split `decisions.md` and `journal.md` into per-year files (historical only; current year stays live) | ✓ | ✓ |
| 0012 | Remove Windsurf scaffolding; update `platforms.js` | ✓ | n/a |
| 0013 | Backfill prune for transactions older than 12 months | ✓ | reversible via backup |

Every migration writes a pre-migration backup to `backup/<timestamp>-pre-migration-<N>/`.

---

## 4. Token-counting harness

### Entry point

`system/scripts/diagnostics/measure-tokens.js` (Node ESM, no required runtime deps; optional `tiktoken` for sharper counts).

```sh
node system/scripts/diagnostics/measure-tokens.js                    # snapshot
node system/scripts/diagnostics/measure-tokens.js --diff             # diff vs committed baseline
node system/scripts/diagnostics/measure-tokens.js --diff-against=<ref>  # diff vs git ref
node system/scripts/diagnostics/measure-tokens.js --check            # exit non-zero if budget exceeded
node system/scripts/diagnostics/measure-tokens.js --json             # machine-readable
node system/scripts/diagnostics/measure-tokens.js --host=<name>      # include per-host pointer files
```

npm script: `"measure-tokens": "node system/scripts/diagnostics/measure-tokens.js"`.

### Metrics

- **Bytes** (primary): deterministic, provider-neutral.
- **Tokens** (derived): default `Math.ceil(bytes / 3.7)` heuristic; `--tokenizer=tiktoken` opt-in.
- Per-file lines (for cap enforcement).
- Tier-1 cache-stable prefix bytes (sum up to first volatile file).
- Tier-2 per-file cost (so we know which protocols are heavy).

### Validation behaviour

- Reads `system/scripts/diagnostics/lib/token-budget.json` (single source of truth for tier classification + caps).
- **Errors** (not warns) on a Tier-1 file that doesn't exist on disk.
- **Validates cache layout**: warns if a slow file precedes a frozen one.
- Reports `lines (cap: X) ✓/✗` per Tier-1 file and per sub-index.

### Baselines

- Committed at `system/scripts/diagnostics/lib/token-baselines.json`. Updating requires `--update-baseline` and a CHANGELOG note.
- `--diff-against=<git-ref>` reads harness output from another revision via `git show` for PR-time diffs (no external state needed).

### CI integration

```yaml
- name: Token budget check
  run: node system/scripts/diagnostics/measure-tokens.js --check
```

Build fails when Tier 1 exceeds budget.

### Tests

`system/tests/measure-tokens.test.js` covers tier-budget config parsing, deterministic counts on a fixture, `--check` exit codes, `--diff` output.

---

## 5. Multi-host validation

### Six scenarios

| # | Scenario | Pass criteria |
|---|---|---|
| 1 | Cold-session load | Reads ONLY Tier-1 files **in declared order**; no Tier 2/3 in transcript |
| 2 | Routine capture ("I prefer dark roast") | Writes `[preference]` to `inbox.md`; does NOT load `capture-rules.md` |
| 3 | Triggered protocol ("morning briefing") | Fetches `system/jobs/morning-briefing.md`; produces briefing |
| 4 | Reference fetch ("list well-known paths") | Fetches `system/manifest.md` |
| 5 | Multi-session detection | Mentions sibling session — proves `sessions.md` was read |
| 6 | Direct-write correction ("you're wrong, my dentist is Dr. Chen") | Writes correction to `self-improvement/corrections.md` AND updates `profile/people.md` if loaded; no inbox detour |

### Pass/fail classification

- **HARD FAIL** — Tier-1 file not read (rules invisible). Blocks Phase 2 merge.
- **SOFT FAIL** — extra Tier-2 read (token regression, behavior intact). Tracked, doesn't block.
- **SOFT NOTE** — host doesn't expose all internal reads (V11). Document; interpret with judgment.

### Fixture layout

```
system/tests/multi-host/
  scenarios/01–06.md              # prompt + setup + expected
  runners/                        # per-host invocation scripts
  parsers/<host>.js               # transcript → tool-call log
  transcripts/                    # captured runs (gitignored)
  results-<date>.md               # gitignored result archive
  README.md
```

### Automation split

- **Automated** — Claude Code, Codex, Gemini CLI (each via the host's headless mode; exact invocation documented in Phase 1 implementation, not pre-committed here).
- **Manual** — Cursor, Antigravity (IDE-bound). 5-minute checklist in `runners/<host>.md`.

### Drift detection

- `system/jobs/host-validation.md` — quarterly job that prompts the user to run validations and writes results to `state/jobs/failures.md` via the existing failure-surfacing pipeline.
- `docs/host-changelogs.md` — links to where each host announces breaking changes; consulted when validation regresses post-host-update.

### Per-host result format

```json
{
  "host": "claude-code", "host_version": "...",
  "model": "opus-4-7", "model_version": "...",
  "scenario": 1, "result": "pass|hard-fail|soft-fail|soft-note",
  "transcript_ref": "..."
}
```

### Cross-source-of-truth

`validate-host.js` consumes `tier1_files` from `token-budget.json` so we don't maintain two lists.

### Failure-mode design

- Tier-1 carries the 5-line capture checkpoint — capture works even without Tier 2.
- Tier-1 carries immutable rules — safety holds even without operational rules.
- Tier-1 carries the pointer table — agent can always find what it needs.
- Worst case: extra reads → tokens up, behavior unchanged.

---

## 6. Performance & reliability extras

### P1. Retire `startup-check.js` subprocess
Move dynamic checks into `robin configure / init / validate` (where config actually changes); session start gets nothing extra. Background validation runs via the reconciler. Saves ~150–300ms per session.

### P2. `migrate.js` fast-path
Push the early-exit *into* `migrate.js`: read `state/last-migration-applied`, compare to highest migration number, exit when nothing pending. Total cold start ~50ms in the no-op case. Agent always invokes the same command.

### P3. Read-before-write conditional
New rule: *"You may skip the re-read if (a) you read the file earlier this turn, AND (b) no `Bash`, `Write`, `Edit`, or `NotebookEdit` tool has run since then. Any other tool (Read, Grep, etc.) is safe."*

### P4. INDEX regeneration throttling
Dream batches sub-index updates; main INDEX regenerates only when a top-level entry changes. Sub-indexes regenerate when their tree changes.

### R1. Capture pipeline collapse
Tier-1 5-line capture rule:
> **Capture checkpoint (always-on).** After every response, scan for capturable signals.
> Direct-write to file: (a) corrections to assistant behavior, (b) user-stated "remember this", (c) updates that supersede a fact in a file currently in your context.
> Inbox-write `[tag]` for everything else (Dream routes within 24h).
> Tags: `[fact|preference|decision|correction|task|update|derived|journal|?]`.
> For routing details, read `system/rules/capture.md`.

### R2. Capture redundancy (defense in depth)
The capture rule lives in AGENTS.md AND `system/rules/capture.md`. AGENTS.md wins on conflict.

### R3. Lint enforcement (CI hard-fail unless noted)

| Check | Failure mode |
|---|---|
| Tier 1 token budget (≤5,000) | Hard |
| Tier 1 line caps per file | Hard |
| Sub-index line caps (≤30) | Hard |
| Tier 1 file existence | Hard |
| Cache ordering frozen→slow→volatile | Hard |
| Profile caps (identity ≤100, personality ≤100) | Hard |
| `hot.md` ≤60 lines, ≤2 sessions | Soft (warn) — Dream trims |
| `regenerate-memory-index.js --check` clean | Hard |
| AGENTS.md doesn't reference removed-host files | Hard |
| Orphan files under `user-data/memory/` (not in any INDEX) | Hard |
| Sub-tree >10 files without sub-index | Hard |

### R4. Atomic write extensions
- `inbox.md` keeps **append + lock** (using existing `lib/sync/` lock helper); not RMW.
- `state/sessions.md` already concurrent-safe; verify.
- `hot.md` keeps append; Dream's trim takes a write-lock.

### R5. Migration safety contract
`system/migrations/CONTRIBUTING.md` codifies: idempotent, pre-migration backup, reversible (or documented why not), tests cover happy path + corrupt + partial state.

### R6. Golden-session test
`system/tests/golden-session.snapshot.json` snapshots host-agnostic Tier-1 expected loads. Updates require `--update-snapshot` flag and CHANGELOG entry. Catches accidental Tier-1 additions in CI.

---

## 7. Memory pruning (R7)

### Active vs cold (cutoff: 12 months across the board)

| Source | Active (Tier 2 loadable) | Cold (Tier 3, archive/) |
|---|---|---|
| `lunch-money/transactions/<month>.md` | Last 12 months | `archive/transactions/<year>/` |
| `knowledge/conversations/<file>.md` | Last 12 months | `archive/conversations/<year>/` |
| `decisions.md` | Current year | `archive/decisions-<year>.md` |
| `journal.md` | Current year | `archive/journal-<year>.md` |
| `self-improvement/calibration.md` | Last 100 entries | `archive/calibration-<period>.md` |
| `inbox.md` | Unrouted only | (Dream removes routed) |
| `sources/` | All | Never pruned |

### Mechanism: `system/jobs/prune.md`

Frontmatter: monthly cron `0 5 1 * *`, default `enabled: false`, trigger phrases "prune memory", "memory cleanup". Owned by the existing job system; emits to `state/jobs/INDEX.md` + `failures.md`.

Per cycle:
1. Skip if `state/sessions.md` has any active rows; log INFO; retry next cycle.
2. **Dry-run scan** → `state/jobs/prune-preview.md`.
3. **Pre-prune backup** to `backup/<timestamp>-pre-prune/`.
4. **Atomic moves** under file lock (active → archive).
5. Decisions/journal split happens at the **first prune of a new calendar year**.
6. **Index update** — sub-indexes regenerated; main INDEX shows one row per archived bucket.
7. **Diff report** to `state/jobs/prune-<timestamp>.md`.

### Safeguards
- First run requires `robin run prune --confirm`. Cron fires only when `enabled: true`.
- Atomic moves preserve identity; never delete + recreate.
- Pre-prune backup retention: keep last 3, older deleted by `system-maintenance.md`.
- Lint check: archived files reachable via `archive/INDEX.md`. No orphans.
- `--dry-run` mode for inspection.

### Yearly synthesis (deliberately not built into prune)
Yearly summaries (totals, anomalies, top counterparties) are produced **on demand** when Kevin asks, OR incrementally by `monthly-financial.md`. Prune itself only archives — keeps Dream's per-cycle budget bounded.

### Reachability
Pruning relocates, never deletes. `archive/INDEX.md` lists what's where (one row per archived bucket — keeps it compact even after 20 years). Active code paths default to active tier; archive access is explicit via the Tier-1 pointer.

### Migrations (mostly in Phase 2, not Phase 4)
- 0010 — archive scaffolding (Phase 2a, because Tier 1 references `archive/INDEX.md`).
- 0011 — decisions/journal per-year split (Phase 2a).
- 0013 — backfill prune (Phase 4, after the job ships).

---

## 8. Phasing & rollout

Each phase: own PR, own validation gate, own rollback. Each phase runs in a `git worktree` per the using-git-worktrees skill.

### Phase 0 — Harness foundation

**Deliver:** `measure-tokens.js`, `token-budget.json` (observe-only — no caps yet), `tokenizer.js`, tests, baseline snapshot at `token-baselines.json`. CI step writes harness output as PR comment.

**Gate:** harness deterministic across 3 runs; baseline matches reality.

**Risk:** zero. Rollback: delete files.

### Phase 1 — Validation tooling

**Deliver:** `validate-host.js` + per-host parsers, 6 scenarios + setup, `system/jobs/host-validation.md` (default disabled), manual checklists for Cursor + Antigravity. **No baseline run yet** — Phase 1 ships the tool only.

**Gate:** code reviewed, tests pass.

**Risk:** low.

### Phase 2 — Tier reorganization (highest blast radius)

Sub-phase order:

1. **2a — Migrations 0008 + 0009 + 0010 + 0011** (file moves first: split self-improvement, build sub-indexes, scaffold archive, split decisions/journal). Each migration has its own commit.
2. **2b — Manifest + capture-rules tightened** in place (still Tier 2; AGENTS.md still references).
3. **2c — AGENTS.md slim** (now references real Tier-2 files, including `archive/INDEX.md`).
4. **2d — `startup.md` collapse** into AGENTS.md.
5. **2e — Migration 0012** — drop Windsurf; refresh README/CHANGELOG.
6. **2f — Token budget caps activated** in `token-budget.json`; harness flips from observe-only to `--check`.

**End-of-sub-phase smoke test:** open a fresh Claude Code session in the worktree, ask "what protocols are available?" → expect coherent answer. If fail, revert.

**End-of-phase gate:**
- `--diff` shows Tier-1 ≤ baseline × 0.5.
- All 6 multi-host scenarios pass on the 3 automated hosts.
- Manual checklists run on Cursor + Antigravity.
- Existing test suite green.
- Manual sign-off from user on a real session.

**Abort criterion:** >1 host hard-failing on Phase 2f terminates the rollout. Revert to Phase 1 baseline; redesign Tier 1 with weaker lazy-loading assumptions before re-attempting.

**Rollback:** per-commit revert; expect 1 cache-cold session per active host post-revert.

### Phase 3 — Performance & reliability

Order:
1. **3a — R3 lint enforcement** (cement Phase 2 caps).
2. **3b — R5 migration contract** (docs).
3. **3c — P3 read-before-write rule** (small Tier 1 edit, batched with Phase 2 cache disturbance).
4. **3d — R6 golden-session test** (captures Phase 2 final state).
5. **3e — R4 atomic write extensions**.
6. **3f — P2 `migrate.js` fast-path**.
7. **3g — P4 INDEX throttling**.
8. **3h — P1 `startup-check.js` retirement** (last; biggest blast radius. Keep the script unlinked for one release).

**Per-item gate:** tests green, harness diff shows no Tier-1 regression.
**3h-specific gate:** Phase 1 full re-run on all hosts.

### Phase 4 — Memory pruning behaviour

1. **4a — `system/jobs/prune.md`** (default `enabled: false`).
2. **4b — Migration 0013** (backfill prune for >12-month-old transactions).
3. **4c — Dry-run review** — Kevin runs `robin run prune --dry-run`; reviews preview.
4. **4d — First confirmed run** — `robin run prune --confirm`.
5. **4e — `archive/INDEX.md` review** — Kevin verifies.
6. **4f — Cron enabled** — only after 4e is reviewed.

**Gate:** migrations idempotent; preview accurate; archived files reachable; multi-session safety verified.

### Phase 5 — Sustained governance (ongoing)

**Deliverables:**
- `docs/governance/token-budget.md` — rules + escalation policy.
- `CODEOWNERS` rule routing `token-budget.json` changes to a reviewer.
- CI label `tier1-changes` auto-applied when `tier1_files` mtime changes.
- Quarterly `host-validation.md` job firing.
- Per-protocol token cap (3,000) lint-checked on additions.

### Cross-phase rules

- Phase N gate must pass before Phase N+1 starts.
- Migrations are sequential by number; can't reorder after merge.
- User sign-off required at end of Phase 2 and Phase 4.
- No phase touches `user-data/memory/` except via migrations + the prune job.
- CHANGELOG entry per phase.
- Each phase runs in a `git worktree`.

### Estimated effort

| Phase | Span | PRs |
|---|---|---|
| 0 — Harness | 1 day | 1 |
| 1 — Validation tooling | 1–2 days | 1 |
| 2 — Tier reorg | 3–5 days | 6 |
| 3 — Perf/reliability | 2–3 days | 8 |
| 4 — Pruning | 1–2 days + dry-run | 6 |
| 5 — Governance | ongoing | n/a |

Realistic calendar with review cycles: **2–3 weeks**.

---

## 9. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Frontier model regresses on lazy-loading | Multi-host validation; Phase 2f abort criterion |
| Tier-1 budget creep over time | CI lint check; `tier1-changes` label; CODEOWNERS review |
| Migration corrupts user data | Pre-migration backup; idempotency tests; reversible-by-default contract |
| Prune deletes wrong content | Default disabled; dry-run gate; pre-prune backup; atomic moves |
| Multi-session race during prune | Skip when `sessions.md` has active rows |
| Cache invalidation on revert | Documented; expect 1 cache-cold session per host |
| Host elides internal reads (can't verify "did NOT read X") | Documented as Soft Note; judgment-based interpretation |

---

## 10. Open questions

None at design time. Implementation may surface host-specific transcript-parsing details for the validation harness; resolve in Phase 1.

---

## 11. References

- [Antigravity rules support — AGENTS.md since v1.20.3](https://antigravity.codes/blog/user-rules)
- [Cursor Rules docs — AGENTS.md is current; .cursorrules deprecated](https://cursor.com/docs/rules)
- Existing migration patterns — `migrations/0007*` (mtime guard, quarantine on corrupt state)
- Existing atomic-write helpers — `system/scripts/sync/lib/`
- Existing job system — `system/jobs/`, `state/jobs/INDEX.md`, `failures.md`
