---
name: sync-github
description: Pull GitHub activity, notifications, and starred-repo releases.
runtime: node
enabled: false
schedule: "0 * * * *"
command: node user-data/scripts/sync-github.js
catch_up: true
timeout_minutes: 5
notify_on_failure: true
---

Pulls last-30-days authored events, current notifications, and recent
releases from starred repos. Writes activity.md / notifications.md /
releases.md to user-data/memory/knowledge/github/.

Disabled by default. Enable after running:

  # 1. Generate a fine-grained PAT at https://github.com/settings/tokens?type=beta
  # 2. Add GITHUB_PAT=<token> to user-data/secrets/.env
  node user-data/scripts/auth-github.js
  node user-data/scripts/sync-github.js --bootstrap
  node bin/robin.js jobs enable sync-github

Auth uses GITHUB_PAT in user-data/secrets/.env (no OAuth flow).
