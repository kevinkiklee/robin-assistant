---
name: sync-lunch-money
description: Pull Lunch Money accounts and transactions, write to memory.
runtime: node
enabled: true
schedule: "0 1 * * *"
command: node user-data/ops/scripts/sync-lunch-money.js
catch_up: true
timeout_minutes: 5
notify_on_failure: true
---

Pulls Plaid accounts, manual assets, and transactions from Lunch Money since
the last sync (with 7-day overlap). Writes accounts snapshot, transactions,
and the investment ledger to user-data/memory/knowledge/finance/lunch-money/
and regenerates user-data/memory/INDEX.md.

Requires LUNCH_MONEY_API_KEY in user-data/ops/secrets/.env.
