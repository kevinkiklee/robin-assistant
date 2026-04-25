# Coordination System

Multi-session safety layer for concurrent Claude Code sessions.

## Architecture

- **Scripts** live in `core/coordination/` (updated with the package)
- **State** lives in `.state/coordination/` (ephemeral, gitignored, survives core updates)
  - `sessions/` — one file per active session
  - `locks/` — mkdir-based atomic locks for pillar file edits

## Pillar files (require locks before editing)

- `CLAUDE.md`
- Any `INDEX.md`
- `profile/personality.md`

## Append-only files (no locks needed, multiple sessions can write)

- `inbox/inbox.md`
- `self-improvement/mistakes.md`, `corrections.md`, `wins.md`, `near-misses.md`, `blind-spots.md`
- `self-improvement/session-handoff.md`
- `journal/*.md`

Convention: new entries appended below the append-only marker. Never edit existing entries except to mark resolved.

## Session lifecycle

```
# Start (on session startup)
SESSION_ID=$(core/coordination/register-session.sh start <config-name> "" 2>&1)

# Heartbeat (periodic, optional)
core/coordination/register-session.sh heartbeat $SESSION_ID

# End (on session close)
core/coordination/register-session.sh end $SESSION_ID

# Cleanup (auto, removes stale sessions/locks >300s)
core/coordination/register-session.sh cleanup
```

## Lock lifecycle

```
# Before editing a pillar file
core/coordination/lock.sh acquire <file> $SESSION_ID

# After editing
core/coordination/lock.sh release <file> $SESSION_ID
```

Exit codes: 0=acquired, 1=held by another session, 2=stale (auto-cleaned), 3=ownership mismatch on release.
