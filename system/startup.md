# Session Startup

## Pre-flight check

Before anything else, run `node system/scripts/startup-check.js` and read its output line-by-line. Treat lines beginning with `FATAL:` as halt conditions — surface the message to the user and abort startup. Surface `INFO:` and `WARN:` lines as a brief summary at the top of your first response. Then continue with the sequence below.

## Sequence

1. **Register session** — append a row to `user-data/state/sessions.md` with your session ID (`<platform>-<timestamp>`, e.g. `claude-code-20260426T090000Z`), platform, start time, and "Last active" = now. Remove any entries with "Last active" older than 2 hours (stale sessions).

2. **Check for sibling sessions** — if `user-data/state/sessions.md` has other active entries, note to the user: "Another session is active (platform X, started Y)." Continue normally.

3. **Dream check** — read `user-data/state/dream-state.md`. If 24+ hours have passed since the last dream, run Dream (see `system/operations/dream.md`). Skip silently if not eligible or if 2+ other sessions are active.

4. **Read context** — read in this order, respecting the startup budget (`memory.startup_budget_lines`, default 500):
   1. `system/manifest.md` — memory overview
   2. `user-data/memory/INDEX.md` — memory tree map
   3. `user-data/memory/hot.md` — recent session context for seamless continuation
   4. Identity and personality:
      - If `user-data/memory/profile/identity.md` exists, read it plus `user-data/memory/profile/personality.md`.
      - Otherwise (monolith state — `npm run split-monoliths` has not yet been run), read the personality and identity sections of `user-data/memory/profile.md`.
   5. These sections of `user-data/memory/self-improvement.md`: Session Handoff (capture sweep status), Communication Style (how to interact), Domain Confidence (where to be cautious vs. autonomous), Learning Queue (one question ready if a natural moment arises).

   Open everything else on demand by consulting INDEX.md. Don't summarize what you read unless asked. `user-data/memory/LINKS.md` and `user-data/memory/log.md` are on-demand only — do not load at startup.

5. **Capture checkpoint** — after every response, run the capture signal scan from `system/capture-rules.md`. Scan for facts, preferences, decisions, corrections, updates, contradictions, and derived insights. Write captures to `user-data/memory/inbox.md` with tags (or direct-write for exceptions). This is not optional — it is the primary mechanism that keeps Robin's memory current. During complex multi-step work, buffer captures and batch-write at the next natural break.

6. **Capture sweep** — when context compaction is imminent, run a mini-sweep of the about-to-be-lost context for missed captures. At graceful session end, run a full sweep if the session involved meaningful conversation. See `system/capture-rules.md` → Capture sweep for the full process.

7. **Respond to user**

## First-run detection

If `user-data/robin.config.json` has `"initialized": false`, enter first-run mode:
- Introduce yourself briefly (2-3 sentences)
- Ask the user's name and timezone
- After collecting: update `user-data/robin.config.json` with name and timezone, set `initialized: true`
- Get to work on whatever they need
