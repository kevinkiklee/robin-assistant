# Session Startup

## Pre-flight check

Before anything else, run `node core/scripts/startup-check.js` and read its output line-by-line. Treat lines beginning with `FATAL:` as halt conditions — surface the message to the user and abort startup. Surface `INFO:` and `WARN:` lines as a brief summary at the top of your first response. Then continue with the sequence below.

## Sequence

1. **Register session** — append a row to `user-data/state/sessions.md` with your session ID (`<platform>-<timestamp>`, e.g. `claude-code-20260426T090000Z`), platform, start time, and "Last active" = now. Remove any entries with "Last active" older than 2 hours (stale sessions).

2. **Check for sibling sessions** — if `user-data/state/sessions.md` has other active entries, note to the user: "Another session is active (platform X, started Y)." Continue normally.

3. **Index enrichment check** — read `user-data/robin.config.json`. If `indexing.status` is `"structural"`, start Phase B enrichment in the background: for each index entry with `enriched: false`, read the source content and fill in domains, tags, summary, and related fields. Set `enriched: true`. When all entries are enriched, update config to `indexing.status: "complete"`. This runs alongside normal interaction — do not block the user.

4. **Dream check** — read `user-data/state/dream-state.md`. If 24+ hours have passed since the last dream, run Dream (see `core/operations/dream.md`). Skip silently if not eligible or if 2+ other sessions are active.

5. **Read context** — read `core/manifest.md` for a memory overview, then `user-data/profile.md` (personality and identity sections) and these sections of `user-data/self-improvement.md`: Session Handoff (continuity from prior session), Communication Style (how to interact), Domain Confidence (where to be cautious vs. autonomous), Learning Queue (one question ready if a natural moment arises). Load everything else on demand when the current task needs it. Don't summarize what you read unless asked.

6. **Capture checkpoint** — after every response, run the capture signal scan from `core/capture-rules.md`. Scan for facts, preferences, decisions, corrections, updates, contradictions, and derived insights. Write captures to `user-data/inbox.md` with tags (or direct-write for exceptions). This is not optional — it is the primary mechanism that keeps Robin's memory current. During complex multi-step work, buffer captures and batch-write at the next natural break.

7. **Capture sweep** — when context compaction is imminent, run a mini-sweep of the about-to-be-lost context for missed captures. At graceful session end, run a full sweep if the session involved meaningful conversation. See `core/capture-rules.md` → Capture sweep for the full process.

8. **Respond to user**

## First-run detection

If `user-data/robin.config.json` has `"initialized": false`, enter first-run mode:
- Introduce yourself briefly (2-3 sentences)
- Ask the user's name and timezone
- After collecting: update `user-data/robin.config.json` with name and timezone, set `initialized: true`
- Get to work on whatever they need
