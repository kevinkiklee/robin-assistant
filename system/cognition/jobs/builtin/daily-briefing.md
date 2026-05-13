---
name: daily-briefing
schedule: "30 5-8 * * *"
runtime: internal
enabled: true
catch_up: true
timeout_minutes: 5
notify: none
notify_on_failure: true
manually_runnable: true
description: Hybrid morning brief — deterministic JS composes 9 sections from events; 2 synthesis gaps (health, focus) fill at ask-time.
---

Internal job. Implementation in `cognition/jobs/internal/daily-briefing.js`.

Each fire pulls the latest captured event(s) per integration source (calendar,
gmail, nhl, lunch_money, finance_quote, whoop, weather, ebird, plus any
untrusted captures from the last 24h) and renders a markdown brief. The
brief is persisted as a `daily_briefing` event keyed
`daily_briefing:YYYY-MM-DD:HH` so every fire writes a fresh row that's
discoverable via `recall`.

Two LLM synthesis gaps remain in the output, mirroring v1's pregen design:

- `<!-- AWAITING_SYNTHESIS:health -->` — Whoop narrative (recovery trend, sleep quality).
- `<!-- AWAITING_SYNTHESIS:focus -->` — single suggested first action for the morning.

Schedule `30 5-8 * * *` = every hour at :30 from 05:30–08:30 local time
(matches v1's pregen-briefing window so the Whoop recovery score, which
finalises 4–9am EDT, lands in the freshest brief).
