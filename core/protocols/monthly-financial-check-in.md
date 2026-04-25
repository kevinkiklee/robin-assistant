# Protocol: Monthly Financial Check-In

## Triggers
"monthly financial check-in", "month-end review", "let's check my finances"

## Steps
1. **Income reconciliation** — paychecks landed as expected? Any vesting events this month?
2. **Recurring outflows** — verify against `memory/long-term/financial-snapshot.md`
3. **Variable spending** — pull receipts via subscription-audit and receipt-tracking. Compare to any spending caps the user has set.
4. **Account balances** — ask the user for current balances across their accounts (checking, savings/HYSA, investment, retirement, HSA).
5. **Debt progress** — review any outstanding balances tracked in `memory/long-term/financial-snapshot.md`.
6. **Plan progress** — read `memory/short-term/financial-plan-status.md`, advance phase if criteria met.
7. **Tax check** — any estimated tax due this quarter? Withholding still on track?
8. **Net worth delta** — month-over-month change.

## Output
Structured summary with:
- Cashflow (in vs out)
- Net change in net worth
- Plan progress (what advanced, what's stuck)
- Anomalies / things needing attention
- Next month's priorities

## After
Update `memory/short-term/financial-plan-status.md`. Move completed phase items to log if a phase is finished.
