# Polish Phase A — Log baseline

**Captured:** 2026-05-17
**Duration per sample:** 3 minutes (reduced from the plan's 10m — controller decision at execution time; A.4 thresholds will be re-scaled to this window).

## Idle baseline (3 min, no traffic)

```
# Log baseline (--idle, 3m)
# Total lines: 0
# Unique patterns: 0
# Top 10 patterns:
```

## Active baseline (3 min, scripted recall + remember traffic)

```
# Log baseline (--active, 3m)
# Total lines: 0
# Unique patterns: 0
# Top 10 patterns:
```

## Notes on this capture

Both 3-minute windows captured **zero** new bytes appended to `user-data/runtime/logs/daemon.log`. Observations:

- Daemon process (`robin mcp start --foreground`, pid 47498) was running throughout both windows.
- SurrealDB (pid 41990) was also running.
- `daemon.log` mtime was 2026-05-17 14:03 going into the idle window and remained 14:03 after both windows finished — the file was not appended to during either capture.
- Last lines in `daemon.log` immediately before the runs were ordinary scheduler/integration activity (finance_quote tick, google_calendar tick, robin-web ready, etc.).
- The active-traffic helper spawned `node system/bin/robin recall` / `remember` subprocesses every 5 seconds for 3 minutes. Either those subprocess CLI invocations did not produce daemon-log writes (most likely — CLI subcommands may not require daemon round-trips, or they failed silently because the JSON-as-arg shape isn't accepted by `system/bin/robin`), OR the daemon's logging was paused/buffered during the window.
- This baseline records what actually happened on the wall clock. Subsequent A.4 work should treat "0 / 0 / 0" as the empirical idle and active floor for this 3-minute window on 2026-05-17, captured against a daemon that may have been quiescent or whose log writes were not flushing.

## Deltas measured against this file:
- A.4 idle target: ≥50% reduction in total lines.
- A.4 idle: no pattern repeating >2× per minute (3-min window: ≤6 occurrences per pattern).
- A.4 active: no pattern repeating >5× per minute (3-min window: ≤15 occurrences per pattern).
- A.4 active: total volume ≤2× idle.

With both samples measuring zero lines, A.4 will need either (a) a fresh re-capture against a known-active daemon, or (b) a synthesized baseline derived from prior log samples. Either path is documented as a Phase A.4 decision; this file is the empirical input regardless.
