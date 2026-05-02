---
name: email-triage
triggers: ["triage my inbox", "email triage", "go through my email"]
description: Classify and process unread email; surface action items, route receipts, and queue follow-ups.
runtime: "agent"
enabled: false
timeout_minutes: 15
---
# Protocol: Email Triage

## Triggers

"triage my inbox", "email triage", "go through my email", "what's in my inbox", "check my email"

## Prerequisites

Read `user-data/runtime/config/integrations.md` for email status.
- If email is not available: ask the user to paste or forward email content, then proceed with classification below.

## Steps

1. Get inbox threads (unread or all, based on user preference).
2. For each thread, classify:
   - **Action required** — needs response or task. Suggest a todo + draft response if quick.
   - **FYI / read later** — informational. Note key point.
   - **Receipt / billing** — extract amount, vendor, date. Log to `user-data/memory/knowledge/finance/subscriptions.md` if recurring.
   - **Newsletter / promo** — note if anything actionable, suggest unsubscribe if low value.
   - **Spam / junk** — flag for cleanup.
3. Group output by category. Within "Action required," sort by urgency.

## Output format

```
## Action Required (N)
- [Subject] — From: X — Why: short reason -> suggested action

## FYI (N)
- [Subject] — One-line summary

## Receipts/Billing (N)
- [Vendor] — $X — date

## Promos/Newsletters (N)
- [List]
```

## After triage

Ask: "Want me to draft replies, add todos for any of these, or unsubscribe from anything?"
