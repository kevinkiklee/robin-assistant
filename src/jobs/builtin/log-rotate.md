---
name: log-rotate
schedule: "0 */6 * * *"
runtime: internal
enabled: true
catch_up: false
timeout_minutes: 1
notify: none
notify_on_failure: true
manually_runnable: true
description: Rotate daemon.log when it exceeds the configured size threshold (default 10 MB).
---
