---
name: _robin-sync
triggers: []
description: Reconciler heartbeat — picks up new/removed jobs, re-installs scheduler entries, and dispatches missed runs.
runtime: node
enabled: true
schedule: "*/15 * * * *"
command: node system/scripts/jobs/reconciler.js
run_at_load: true
timeout_minutes: 1
notify_on_failure: false
---

Heartbeat that runs every 15 minutes (and at every launchd load via
`run_at_load: true`, so it fires after login / reboot / plist changes).

Reads system/jobs/ and user-data/runtime/jobs/, diffs against currently
installed scheduler entries, and applies the delta. Hash-based early-exit
keeps the no-op path sub-10ms — that's why catch-up is allowed: re-running
the heartbeat after a long gap is cheap, and we *want* the reconciler to
run on the next firing after wake/login so it can dispatch missed jobs.

Also regenerates INDEX.md, upcoming.md, and failures.md, cleans up orphaned
per-job state files, and — crucially — dispatches any job whose `last_run_at`
is older than 1.5x its expected interval. macOS launchd silently drops
`StartCalendarInterval` firings during sleep / clamshell / login-session
glitches; this catch-up dispatch is the safety net that ensures missed runs
self-heal within 15 minutes of the system being responsive again.

The dispatched runner re-checks catch-up before executing, and per-job locks
prevent overlap with a concurrent launchd-fired runner.
