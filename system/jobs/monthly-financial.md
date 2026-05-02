---
name: monthly-financial
triggers: ["month-end review", "monthly financial"]
description: Month-end financial review covering income reconciliation, recurring outflows, and budget variance.
runtime: "agent"
schedule: "0 9 1 * *"
enabled: false
catch_up: true
timeout_minutes: 30
notify_on_failure: true
---
# Protocol: Monthly Financial Check-In

## Triggers

"monthly financial check-in", "month-end review", "let's check my finances"

## Steps

1. **Income reconciliation** — paychecks landed as expected? Any vesting events this month?
2. **Recurring outflows** — verify against `user-data/memory/knowledge/finance/subscriptions.md` (create the file if it does not yet exist).
3. **Variable spending** — use receipt-tracking and subscription-audit protocols if email is available. Otherwise ask the user for a spending summary.
4. **Account balances** — ask the user for current balances across accounts (checking, savings, investment, retirement, HSA).
5. **Debt progress** — review any outstanding balances tracked under `user-data/memory/knowledge/finance/` (e.g., `financial-snapshot.md`).
6. **Tax check** — any estimated tax due this quarter? Withholding on track?
7. **Net worth delta** — month-over-month change.

## Output

- Cashflow (in vs out)
- Net change in net worth
- Anomalies / things needing attention
- Next month's priorities

## After

Update the appropriate `user-data/memory/knowledge/finance/` subtopic file(s) with any new financial facts. Log the review in `user-data/memory/streams/journal.md`.
