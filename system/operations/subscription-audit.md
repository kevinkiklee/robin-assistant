---
name: subscription-audit
triggers: ["what am I paying for", "subscription audit"]
description: Audit recurring charges and subscriptions; surface candidates to cancel or renegotiate.
---
# Protocol: Subscription Audit

## Triggers

"subscription audit", "find my subscriptions", "what am I paying for", "audit recurring charges"

## Steps

### 1. Gather charges

Read `user-data/integrations.md` for email status.
- If email available: search for recurring-charge signals — "subscription", "renewal", "auto-renew", "monthly payment", "annual subscription", "your receipt", "invoice", "billing". Search common providers: streaming, music, cloud storage, SaaS, gym, insurance.
- If not available: ask "Can you paste a recent bank statement or list your known recurring charges?"

### 2. Extract per charge

- Vendor name
- Amount
- Frequency (monthly/annual)
- Last charge date

### 3. Cross-reference

Read `user-data/memory/knowledge.md` -> `## Subscriptions` for previously tracked charges.

### 4. Flag

- Charges not in `user-data/memory/knowledge.md`
- Mystery charges (unknown or unexpected)
- Duplicates
- Forgotten subscriptions (not used recently)

## Output

| Vendor | Amount | Freq | Last charge | Notes |

## After audit

Suggest cancellations. Update `user-data/memory/knowledge.md` -> `## Subscriptions` with confirmed recurring charges.
