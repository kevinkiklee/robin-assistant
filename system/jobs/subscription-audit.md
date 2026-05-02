---
name: subscription-audit
triggers: ["what am I paying for", "subscription audit"]
description: Audit recurring charges and subscriptions; surface candidates to cancel or renegotiate.
runtime: "agent"
schedule: "0 9 15 * *"
enabled: false
catch_up: true
timeout_minutes: 15
notify_on_failure: true
---
# Protocol: Subscription Audit

## Triggers

"subscription audit", "find my subscriptions", "what am I paying for", "audit recurring charges"

## Steps

### 1. Gather charges

Read `user-data/ops/config/integrations.md` for email status.
- If email available: search for recurring-charge signals — "subscription", "renewal", "auto-renew", "monthly payment", "annual subscription", "your receipt", "invoice", "billing". Search common providers: streaming, music, cloud storage, SaaS, gym, insurance.
- If not available: ask "Can you paste a recent bank statement or list your known recurring charges?"

### 2. Extract per charge

- Vendor name
- Amount
- Frequency (monthly/annual)
- Last charge date

### 3. Cross-reference

Read `user-data/memory/knowledge/finance/subscriptions.md` for previously tracked charges.

### 4. Flag

- Charges not in `user-data/memory/knowledge/finance/subscriptions.md`
- Mystery charges (unknown or unexpected)
- Duplicates
- Forgotten subscriptions (not used recently)

## Output

| Vendor | Amount | Freq | Last charge | Notes |

## After audit

Suggest cancellations. Update `user-data/memory/knowledge/finance/subscriptions.md` with confirmed recurring charges.
