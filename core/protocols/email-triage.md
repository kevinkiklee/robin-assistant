# Protocol: Email Triage

## Triggers

"triage my inbox", "email triage", "go through my email", "what's in my inbox"

## Prerequisites

Read `integrations.md` for email status.
- If email is not available: ask the user to paste or forward email content, then proceed with classification below.

## Steps

1. Get inbox threads (unread or all, based on user preference).
2. For each thread, classify:
   - **Action required** — needs response or task. Suggest a todo + draft response if quick.
   - **FYI / read later** — informational. Note key point.
   - **Receipt / billing** — extract amount, vendor, date. Log to `knowledge.md` -> `## Subscriptions` if recurring.
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
