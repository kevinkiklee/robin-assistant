# Protocol: Email Triage

## Triggers
"triage my inbox", "email triage", "go through my email", "what's in my inbox"

## Steps
1. Search Gmail INBOX (label `INBOX`, optionally filter to UNREAD).
2. For each thread, classify:
   - **Action required** — needs response or task. Suggest a todo + draft response if quick.
   - **FYI / read later** — informational. Note key point.
   - **Receipt / order / billing** — extract amount, vendor, date → log to `knowledge/references/receipts.md` if recurring or notable.
   - **Newsletter / promo** — note if anything actionable, suggest unsubscribe if low value.
   - **Spam / junk** — flag for cleanup.
3. Group output by category. Within "Action required," sort by urgency.

## Output format
```
## Action Required (N)
- [Subject] — From: X — Why: short reason → suggested action

## FYI (N)
- [Subject] — One-line summary

## Receipts/Billing (N)
- [Vendor] — $X — date

## Promos/Newsletters (N)
- [List]
```

## After triage
Ask: "Want me to draft replies, add todos for any of these, or unsubscribe from anything?"
