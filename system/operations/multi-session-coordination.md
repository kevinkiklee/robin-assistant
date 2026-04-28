---
name: multi-session-coordination
triggers: []
description: Detects concurrent sessions and coordinates handoff via file-based registration and lock acquisition.
---
# Protocol: Multi-Session Coordination

The user may run multiple AI sessions concurrently. This protocol prevents data loss and conflicts using file-based coordination.

## Triggers

- Automatic on every session start (register in `user-data/state/sessions.md`)
- Automatic before editing pillar files (acquire lock)
- "list active sessions", "who else is running", "session status"

## Session ID format

`<platform>-<timestamp>` — e.g., `claude-code-20260426T090000Z`. Read the platform from `user-data/integrations.md` or `user-data/robin.config.json`.

## Session lifecycle

### On startup

1. Read `user-data/state/sessions.md`.
2. Remove entries with "Last active" older than 2 hours (stale).
3. Append a new row: your session ID, platform, start time, last active = now.
4. If other active entries exist, tell the user.

### During session

Update your "Last active" timestamp periodically (~every 10 file operations or before editing pillar files).

### On session end

Best effort: remove your row from `user-data/state/sessions.md`.

## File categories

| Category | Files | Rule |
|----------|-------|------|
| Pillar (always lock) | `AGENTS.md`, `user-data/memory/profile.md`, `user-data/memory/self-improvement.md` | Acquire lock before any edit |
| Mixed-use | `user-data/memory/tasks.md`, `user-data/memory/knowledge.md` | Lock when modifying or removing existing content. Appending a new entry is safe without a lock. When in doubt, lock. |
| Append-only | `user-data/memory/journal.md`, `user-data/memory/decisions.md`, `user-data/memory/inbox.md` | No lock needed. Read-before-write still applies. |

## Lock protocol

To edit a pillar or mixed-use file:

1. Check if `user-data/state/locks/<filename>.lock` exists.
2. If it exists, read it:
   - Timestamp < 5 minutes old -> lock is held. Tell the user: "Another session is editing <file>. Wait or work on something else?"
   - Timestamp > 5 minutes old -> stale lock. Delete the file and proceed.
3. If no lock exists, create `user-data/state/locks/<filename>.lock`:
   ```
   session: <your-session-id>
   acquired: <ISO-8601-timestamp>
   ```
4. **Confirm-after-create:** re-read the lock file immediately. If it contains a different session ID, another session won the race. Delete the lock file, wait briefly, retry from step 1.
5. Read the target file fresh (never trust cached content).
6. Make your edit.
7. Delete the lock file.

## Read-before-write (always)

Read a file immediately before writing to it. Do not rely on content read earlier in the session. Another session may have changed it.

## What this does NOT solve

- Two sessions sending the same email -> use `Rule: Ask vs Act`
- Cross-session context -> Session A's learnings aren't visible to Session B until Session B reads the workspace files
