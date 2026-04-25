# Protocol: Multi-Session Coordination

The user may run Claude Code under multiple configs or terminals concurrently. This protocol prevents data loss and conflicts.

## Triggers
- **Automatic on session start** — every session must register
- **Automatic before pillar file edits** — must acquire lock
- "list active sessions", "who else is running", "session status" — manual checks

## Session lifecycle

### 1. On session start
```bash
SESSION_ID=$(core/coordination/register-session.sh start <config-name> "<current topic if known>")
```

The script prints the session ID on stdout. Capture it. Other active sessions are listed on stderr.

If other sessions are active:
- Tell the user: "Note: another session is active (config X, started Y minutes ago, working on Z)."
- Continue normally — most operations are safe in parallel.

### 2. During the session
Periodically refresh heartbeat (every ~10 tool calls or before pillar edits):
```bash
core/coordination/register-session.sh heartbeat $SESSION_ID
```

### 3. On session end
Best effort cleanup (if the user says "I'm done" or "exit cleanly"):
```bash
core/coordination/register-session.sh end $SESSION_ID
```

Stale sessions get cleaned up by the next session's startup or by `system-maintenance`.

## Pillar file edits

Pillar files require locks. The list:
- `CLAUDE.md`
- Any `INDEX.md`
- `profile/personality.md`
- Anything containing a `# HARD RULES` section

### Edit flow
```bash
# 1. Acquire lock
core/coordination/lock.sh acquire CLAUDE.md $SESSION_ID || exit 1

# 2. Read the file FRESH (don't trust cached context)
# (use Read tool here)

# 3. Edit the file
# (use Edit tool here)

# 4. Release lock
core/coordination/lock.sh release CLAUDE.md $SESSION_ID
```

If acquisition fails, tell the user: "Another session is currently editing <file>. Wait or operate on something else?"

If a session crashes mid-edit, the lock becomes stale after 5 minutes and the next attempt cleans it up.

## Append-only files

These files don't need locks. They're append-only by design.

| File | Append behavior |
|---|---|
| `inbox/inbox.md` | New entries below the APPEND-ONLY marker, newest first |
| `self-improvement/mistakes.md` | Newest entry below header |
| `self-improvement/wins.md` | Newest entry below header |
| `self-improvement/corrections.md` | Newest entry below header |
| `self-improvement/predictions.md` | New table row below existing rows |
| `self-improvement/feedback.md` | Newest entry below header |
| `self-improvement/skill-usage.md` | New table row below existing rows |
| `self-improvement/session-handoff.md` | Newest entry below header |
| `journal/YYYY-MM-DD.md` | Multiple sessions same day → append, don't overwrite |

For these: still re-read before write to get current content. But conflicts are minimal because each session adds its own entry rather than editing existing ones.

## Read-before-write Hard Rule

**Always read a file via the Read tool immediately before editing it.** Do not rely on cached context from earlier reads. Another session may have updated the file since.

This applies to both pillar files (with locks) and any other file you're modifying.

## Conflict detection

If during system maintenance (or on noticing) a file has unexpected content (duplicate entries, garbled merge, missing entries you wrote), assume a concurrent session caused it. Resolve manually and log to `self-improvement/mistakes.md` with category "concurrency-conflict".

## When NOT to use locks

- Reading files (always safe)
- Capture file appends (the convention prevents conflicts)
- Tool calls that don't write to disk (Gmail/Calendar/Drive reads)
- Per-session scratch work that doesn't touch shared files

## Cleanup

`core/coordination/register-session.sh cleanup` removes stale sessions and locks. Called by:
- `system-maintenance` protocol monthly
- Any session that hits a stale-lock situation
- Manually if the user asks

## What this does NOT solve

- Two sessions sending the same email — caller's responsibility (`Rule: Ask vs Act`)
- Two sessions running `system-maintenance` — protocol checks `last-system-maintenance.md` to avoid duplication
- Cross-session memory drift — if Session A learns X, Session B in another terminal won't know until next read. Acceptable.
- Network/MCP rate limits — each session has its own auth; combined load could hit Gmail/Calendar API limits. If this happens, slow down.
