# Protocol: Dream

Lightweight automatic memory consolidation. Runs at session startup when conditions are met. Modeled after Claude's auto-dream mechanic.

## Triggers

Automatic only — invoked from CLAUDE.md Session Startup. Never invoked manually except for testing via `/dream` (not yet implemented).

## Eligibility check

Run after `register-session.sh start`, before reading `personality.md`.

```
1. Read memory/short-term/last-dream.md
   - File missing → cold start: create baseline (status: baseline-only,
     last_dream_at=now, sessions_since=0), write file, SKIP execution.
2. Increment sessions_since by 1, write last-dream.md back.
   - Race-tolerant: occasional undercount is acceptable.
3. Self-disable checks (any → SKIP, do not reset counter):
   - DREAM_DISABLE=1 in env
   - core/coordination/lock.sh missing or non-executable
   - core/coordination/register-session.sh missing
4. Defer check:
   - Run: core/coordination/register-session.sh list | grep -c '^ACTIVE:'
   - If count >= 3 (current + 2 others) → SKIP (do not reset counter)
5. Eligibility:
   - elapsed = now - last_dream_at
   - eligible = (elapsed >= 24h AND sessions_since >= 5)
              OR (elapsed >= 72h)
   - Not eligible → SKIP
6. Eligible → try-acquire dream lock:
   - core/coordination/lock.sh acquire dream $SESSION_ID
   - Exit 1 (held) → SKIP, note in last-dream.md (skip_reason: lock_held)
   - Exit 0 (acquired) → proceed to phases
   - Exit 2 (corrupt) → log to last-dream.md, SKIP
```

After running phases (whether successful, partial, or aborted), always:

```
- core/coordination/lock.sh release dream $SESSION_ID
- Update last-dream.md: last_dream_at=now, sessions_since=0
- Print one-line summary OR escalation report (see Output)
```

## Phases

### Phase 1 — Orient (≤5s)

```
- Read memory/INDEX.md
- ls memory/short-term/ memory/long-term/ inbox/
- Read auto-memory MEMORY.md at:
    AUTO_MEMORY="$HOME/.claude/projects/$(pwd | sed 's|/|-|g')/memory/MEMORY.md"
  Note line count.
```

No content reads beyond indexes and MEMORY.md line count.

### Phase 2 — Gather (≤20s)

```
- LAST_DREAM_TS=$(grep last_dream_at memory/short-term/last-dream.md | cut -d= -f2)
- find memory/ inbox/ -type f -newer <ref-file-with-LAST_DREAM_TS-mtime>
  Hard scope: memory/ + inbox/ ONLY. Never search anywhere else.
- Cap candidate set at 20 files. Excess → log in last-dream.md as deferred,
  surface in next run.
- No MCP calls. No git operations. No reads outside the candidate list.
```

### Phase 3 — Consolidate (≤60s)

**Setup — atomic snapshot:** capture mtimes of all candidates at phase start. Store in memory.

**For each candidate file:**

1. **Privacy scan first.** Scan content being moved or merged against the patterns defined in `core/privacy-scan.md`.

   Match → BLOCK the move/merge, escalate, never silently propagate. Memory file content already in workspace can be left in place; only block ROUTING from inbox into other files.

2. **Date normalization.** Convert relative dates ("Thursday", "next month", "in 2 weeks") to absolute YYYY-MM-DD using today's date.

3. **Contradiction resolution — Rule: Precedence.**
   
   Verification heuristic (apply to each side of contradiction):
   - Has source citation (`From your X email dated Y`, `Per Z statement`) → **verified**
   - Has explicit `verified: true` frontmatter → **verified**
   - Has timestamp + sourced figure → **verified**
   - Otherwise → **stored**
   
   Resolution:
   - One side verified, other stored → keep verified
   - Both verified → keep most recent
   - Both stored → ESCALATE (no coin-flip)

4. **Inbox routing.** For each entry in `inbox/inbox.md`:
   - Apply CLAUDE.md "Where Does This Go?" decision tree
   - Confident single match → move + delete from inbox
   - Multi-classification (e.g., fact + todo) → leave in inbox, ESCALATE
   - Ambiguous → leave in inbox, ESCALATE
   - Time-sensitive (deadline ≤14d) → route AND ESCALATE: "Routed X. Time-sensitive — confirm soon."

5. **Pillar files** (CLAUDE.md, any INDEX.md, profile/personality.md):
   - `core/coordination/lock.sh acquire <file> $SESSION_ID`
   - Exit 1 (held) → skip this file, ESCALATE (skip_reason: pillar_locked)
   - Exit 0 → proceed
   - On finish: `core/coordination/lock.sh release <file> $SESSION_ID`

6. **Cross-file coherence guard — recheck mtime before write:**
   ```
   current_mtime = stat(<file>)
   if current_mtime != snapshot_mtime[<file>]:
     ABORT this consolidation step, ESCALATE
   ```

7. **Read-before-write:** re-read the target file via Read tool immediately before rename, even within same Dream. Build the new content from the fresh read, not from earlier in this Dream.

8. **Atomic write:**
   ```
   write to <file>.dream-tmp
   os.rename(<file>.dream-tmp, <file>)
   ```

### Phase 4 — Prune & Index (≤15s)

**Auto-memory `MEMORY.md`** at `$HOME/.claude/projects/$(pwd | sed 's|/|-|g')/memory/MEMORY.md`:
- Drop entries pointing to deleted files (silent)
- Reorder by relevance (recent + referenced first) (silent)
- Line count check: if >200 lines → ESCALATE for confirmation. Never silently delete entries.

**Workspace `memory/INDEX.md`:**
- Drop entries for files that no longer exist (silent)
- No size cap

**Memory decay flagging:**
- Files in `memory/long-term/` with mtime >180d AND no references in recent conversation → ESCALATE as deletion candidates
- Never delete without confirmation

**Update `memory/short-term/last-dream.md`** — see Output schema below.

## Boundary rule

Dream NEVER edits these directories or files:
- `core/` (any file — templates, protocols, hard rules, coordination scripts)
- `profile/`, `skills/`, `decisions/`, `knowledge/`, `protocols/`, `journal/`, `todos/`, `self-improvement/`
- Source code anywhere
- `.git/` or any git operation (no add, no commit, no push)
- Anything outside `memory/`, `inbox/`, and the auto-memory `MEMORY.md`

Discoveries about other directories → log in `last-dream.md` for next monthly system-maintenance.

## Output

### Default (silent)

One-line summary at session startup:

```
Dreamt: pruned N short-term entries, routed M inbox items, merged K.
MEMORY.md at L lines. Full log: memory/short-term/last-dream.md.
```

### Escalation report (5–15 lines, `## Needs your input` heading)

Triggered by ANY of:

1. Contradiction unresolvable via Rule: Precedence (both sides classify as `stored`)
2. Inbox item with no confident routing target
3. Multi-classification inbox item
4. Memory-decay deletion candidate
5. Auto-memory `MEMORY.md` >200 lines
6. Privacy pattern matched in inbox content (move blocked)
7. Errors during Dream (lock failures, retries, mtime conflicts)
8. >10 items pruned in one pass (sanity check)
9. Previous run aborted (stale lock reclaimed)
10. Routed inbox item references deadline ≤14d (Rule: Verification)

**Tone:** neutral and factual. Report numbers and what was NOT done (skipped, deferred, escalated). No "all clean" framing.

## `last-dream.md` schema

```markdown
---
name: Last Dream
description: Auto memory consolidation state
type: project
---

# Last Dream

last_dream_at: YYYY-MM-DDTHH:MM:SSZ
sessions_since: 0
status: baseline-only | ran | skipped | aborted | partial
last_run_session: <session-id>

## Last summary
[one-line or escalation report from last run]

## Diff log (rolling, last 10 runs)

### YYYY-MM-DDTHH:MM:SSZ — ran
- Pruned: memory/short-term/foo.md (resolved 30+ days ago)
- Routed: inbox: "X" → todos/finance.md
- Merged: spending-analysis (Mar) into Q1 figures
- Phase durations: P1=2s P2=8s P3=42s P4=4s
- Files read: 6, written: 4, deferred: 0

### [older entries truncated after 10]

## Deferred files (next run picks up)

[list of files beyond 20-cap, if any]

## Discoveries for monthly system-maintenance

[non-memory observations: profile drift, decision outcomes ripe, etc.]
```

Keep diff log to last 10 runs; older entries dropped on each write.

## Failure modes & recovery

- **Lock held by another Dream** → skip cleanly, do not reset counter
- **Pillar lock fails** → skip that file, escalate
- **mtime conflict mid-phase** → abort that file's consolidation, escalate
- **Wall-clock >120s** → abort remaining work, mark `status: partial`, release lock, escalate
- **Privacy pattern matched** → block move, log file path + pattern type (NEVER the matched content), escalate
- **Crash mid-run** → next eligible startup: `lock.sh acquire` will detect stale lock (>300s) and reclaim. `last-dream.md` will show `status: aborted` from prior run; surface in escalation.

## Manual rollback

No git operations from Dream. Audit trail = `last-dream.md` diff log. To undo:
1. Read the diff log entry for the run in question
2. Manually restore affected files from before/after snippets
3. Or use `git diff` against last commit to see Dream's changes; `git checkout -- <file>` to revert a specific file

Memory files are small and few; manual restore is feasible.
