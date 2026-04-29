# Session Startup — edge cases

The full startup sequence is inlined in `AGENTS.md`. This file holds edge cases.

## Pre-flight check

`node system/scripts/startup-check.js` outputs lines beginning `FATAL:` /
`WARN:` / `INFO:`. `FATAL:` halts; surface `INFO:`/`WARN:` briefly in the
first response.

## First-run detection

`user-data/robin.config.json.initialized == false`:

- Introduce briefly (2-3 sentences).
- Ask the user's name and timezone.
- Update `robin.config.json` with name + timezone; set `initialized: true`.
- Get to work.

## Dream invocation in-session

Dream runs daily 04:00 via the job system; **does NOT depend on session
startup**. Trigger phrases ("dream", "memory check", "daily maintenance")
invoke it in-session: acquire lock with `robin job acquire dream`, run the
protocol per `system/jobs/dream.md`, release with `robin job release dream`.

## Capture sweep on compaction

When context compaction is imminent, run the mini-sweep per
`system/capture-rules.md` → "Capture sweep". Most important trigger — once
context compacts, detail is gone.

## Read budget

`memory.startup_budget_lines` (default 500) bounds the always-on Tier 1 reads.
The token-budget harness (`system/scripts/measure-tokens.js`) caps stricter
(≤5,000 tokens / ≤250 lines) when `enforce_caps: true`.

## Sibling-session detection

Read `user-data/state/sessions.md` at startup. Other active rows ("Last
active" within 2h): note "Another session is active (platform X, started
Y)." in the first response. Multi-session write coordination per
`system/jobs/multi-session-coordination.md`.
