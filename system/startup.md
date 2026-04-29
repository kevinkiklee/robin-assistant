# Session Startup — edge cases

The full startup sequence is inlined in `AGENTS.md`. This file holds edge cases.

## Pre-flight check

Pre-flight runs at **install / update time**, not on every session:

- `npm install` (postinstall) runs `setup.js` which scaffolds `user-data/`
  and triggers the same checks as `robin update`.
- After `git pull`, run `robin update` to apply pending migrations,
  config additions, and new skeleton files.

Findings written to `state/jobs/failures.md` (active failures) and
`state/jobs/INDEX.md` (job dashboard). The agent reads those at session
start and surfaces relevant items in its first response — no subprocess
needed.

## When to invoke startup-check directly

The legacy `node system/scripts/startup-check.js` still works and is
called by `robin update`. Only invoke it directly when:

- Investigating a bootstrap issue and you want to see all findings inline.
- Running in CI to catch broken state.

Don't call it from agent-runtime code paths — that's what `robin update`
+ `state/jobs/failures.md` are for.

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
