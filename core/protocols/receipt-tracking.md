# Protocol: Receipt Tracking

## Triggers
"track my receipts", "what did I spend on", "find receipts for", "what did I buy from [vendor]"

## Steps
1. Search Gmail for receipt/order keywords + optional vendor/date filter:
   - "receipt", "order confirmation", "your order", "shipped"
   - Vendor name if specified
2. Extract per receipt: vendor, amount, items, date, order ID.
3. If the user is tracking spending in a category (e.g., a monthly cap), sum across the period.

## Use cases
- Tax receipts (HSA-eligible medical, charitable, business)
- Returns/warranties (find original purchase)
- Spending audits (category caps, dining out, gear purchases)
- Big-ticket records (log to relevant `knowledge/references/` file)

## Output
Per-receipt or aggregated summary depending on the question.

## After
If a recurring category audit, log results to relevant memory file. If a one-time lookup, no need to persist.
