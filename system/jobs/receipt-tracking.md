---
name: receipt-tracking
dispatch: subagent
model: opus
triggers: ["track my receipts", "receipt tracking"]
description: Find and summarize receipts by vendor, time range, or category.
runtime: "agent"
enabled: false
timeout_minutes: 15
---
# Protocol: Receipt Tracking

## Triggers

"track my receipts", "what did I spend on", "find receipts for", "what did I buy from [vendor]"

## Steps

### 1. Gather receipts

Read `user-data/runtime/config/integrations.md` for email status.
- If email available: search for receipt/order keywords + optional vendor/date filter — "receipt", "order confirmation", "your order", "shipped".
- If not available: ask "Can you paste or forward the receipts you want tracked?"

### 2. Extract per receipt

Vendor, amount, items, date, order ID.

### 3. Aggregate if needed

If the user is tracking spending in a category (e.g., monthly cap), sum across the period.

## Use cases

- Tax receipts (HSA-eligible medical, charitable, business)
- Returns/warranties (find original purchase)
- Spending audits (category caps, dining out, gear)
- Big-ticket records

## Output

Per-receipt or aggregated summary depending on the question.

## After

If a recurring category audit, log results to the appropriate `user-data/memory/knowledge/finance/` subtopic file (e.g., `spending-analysis.md`). If a one-time lookup, no need to persist.
