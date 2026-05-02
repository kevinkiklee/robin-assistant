---
name: audit
description: Weekly LLM-pass to flag potential contradictions across memory files. Pairs candidate files via LINKS.md, surfaces proposed changes for user review. Never auto-edits.
runtime: agent
schedule: "0 11 * * 0"
enabled: false
catch_up: false
timeout_minutes: 30
notify_on_failure: true
---
# Protocol: audit

Weekly contradiction-detection pass over memory files. The pairing helper generates ≤20 candidate file pairs from `LINKS.md` cross-references + same-sub-tree files, prioritized by recency.

## Context profile

This job runs with **minimal context**. Skip the usual Tier 1 reads — do NOT load `personality.md`, `identity.md`, `communication-style.md`, `domain-confidence.md`, `hot.md`, `session-handoff.md`, `learning-queue.md`. Load ONLY:
- CLAUDE.md Hard Rules section (Privacy, Verification, Local Memory, Time)
- The candidate pair files for each comparison (one pair at a time)
- This protocol

This saves ~3,000 tokens per pair × 20 pairs = ~60k tokens/run.

## Phase 1: Generate pairs

Run:

```sh
node -e "import('./system/scripts/diagnostics/lib/audit-pairs.js').then(m => console.log(JSON.stringify(m.generateAuditPairs(process.cwd()), null, 2)))"
```

(Or call the helper directly if the host supports it.)

Note the returned list of `[fileA, fileB]` pairs. All paths are relative to `user-data/memory/`.

## Phase 2: Per-pair contradiction check

For each pair (one at a time, minimal context per pair):

1. Read both files.
2. Extract claims/facts about shared entities (people, places, dates, decisions).
3. Identify any pair of claims that contradict each other (mutually exclusive).
4. Identify any pair of claims that are near-duplicate (same fact stated in both — redundancy).
5. Skip claims that are clearly compatible (different topics, different time periods with no conflict).

For each finding, record:
- Type: `contradiction` | `redundancy`
- Files: A, B
- Claim A (verbatim short quote)
- Claim B (verbatim short quote)
- Proposed action: nothing automated — describe what the user might do (merge, supersede, contextualize)

## Phase 3: Write findings

Atomically write a summary to `user-data/runtime/state/audit/<YYYY-MM-DD>.md`:

```markdown
# Audit findings — <date>

Pairs reviewed: <N>
Findings: <C contradictions, R redundancies>

## Contradictions

### <fileA> ↔ <fileB>
- Claim A: "..."
- Claim B: "..."
- Suggestion: ...

## Redundancies

### <fileA> ↔ <fileB>
- Shared claim: "..."
- Suggestion: ...

## No-issue pairs

(Optional list of pairs reviewed with no findings.)
```

Use an atomic write: write to `user-data/runtime/state/audit/<YYYY-MM-DD>.md.tmp`, then rename to the final path.

## Phase 4: Surface

Add a one-line summary to `user-data/runtime/state/jobs/INDEX.md` with the count of findings and a pointer to the dated audit file. Format:

```
- [<YYYY-MM-DD>] audit: <C> contradictions, <R> redundancies → state/audit/<YYYY-MM-DD>.md
```

The user reviews findings during their next `system-maintenance` run; nothing is auto-edited.
