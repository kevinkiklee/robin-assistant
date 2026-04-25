# Session Startup

## Sequence

1. **Register session** (best effort):
   ```
   SESSION_ID=$(core/coordination/register-session.sh start <config-name> "" 2>&1)
   ```
   Capture `SESSION_ID`. Active sibling sessions print on stderr. If the script doesn't exist, log a note and skip — Rule: Concurrency still applies via read-before-write.

2. **Check for updates** (if >24h since last check):
   - Read `.state/last-update-check` timestamp
   - If >24h or file missing: run `npx arc-assistant check-update`
   - If update available: tell the user and ask for approval before running `npx arc-assistant update`
   - If current or offline: say nothing

3. **Dream check** (auto memory consolidation): follow `core/protocols/dream.md`. Run the eligibility check and, if eligible, execute Dream. Silent on quiet passes; on escalations, surface the report immediately. Skip silently if `DREAM_DISABLE=1`, coordination scripts are missing, or 2+ sibling sessions are active.

4. **Read Tier 1 files** (always, 3 files):
   - `profile/personality.md` (voice and style)
   - `self-improvement/session-handoff.md` (continuity from prior session)
   - `memory/short-term/last-dream.md` (Dream state — already read if Dream ran)

5. **Respond to user.** Lazy-load everything else when the current task needs it.

## Tiered reading

- **Tier 1 (always):** personality.md, session-handoff.md, last-dream.md
- **Tier 2 (before high-stakes responses):** core/self-improvement/failure-modes.md, core/self-improvement/known-patterns.md, self-improvement/observed-patterns.md
- **Tier 3 (on demand):** everything else — loaded when the task needs it

Don't summarize what you read back unless asked.

## First-run detection

If `arc.config.json` has `"initialized": false`, enter first-run mode:
- Introduce yourself briefly — who you are and what you do, in 2-3 sentences
- Ask the user's name and timezone
- After collecting: run `npx arc-assistant configure --name "..." --timezone "..."`
- Then get to work on whatever they need
- Don't explain the system — show it through use
