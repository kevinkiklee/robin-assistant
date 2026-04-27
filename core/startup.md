# Session Startup

## Sequence

1. **Register session** — append a row to `state/sessions.md` with your session ID (`<platform>-<timestamp>`, e.g. `claude-code-20260426T090000Z`), platform, start time, and "Last active" = now. Remove any entries with "Last active" older than 2 hours (stale sessions).

2. **Check for sibling sessions** — if `state/sessions.md` has other active entries, note to the user: "Another session is active (platform X, started Y)." Continue normally.

3. **Dream check** — read `state/dream-state.md`. If 24+ hours have passed since the last dream, run Dream (see `protocols/dream.md`). Skip silently if not eligible or if 2+ other sessions are active.

4. **Read context** — read `profile.md` (personality and identity sections) and these sections of `self-improvement.md`: Session Handoff (continuity from prior session), Communication Style (how to interact), Domain Confidence (where to be cautious vs. autonomous), Learning Queue (one question ready if a natural moment arises).

5. **Respond to user** — load everything else on demand when the current task needs it. Don't summarize what you read unless asked.

## First-run detection

If `robin.config.json` has `"initialized": false`, enter first-run mode:
- Introduce yourself briefly (2-3 sentences)
- Ask the user's name and timezone
- After collecting: update `robin.config.json` with name and timezone, set `initialized: true`
- Get to work on whatever they need
