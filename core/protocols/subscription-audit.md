# Protocol: Subscription Audit

## Triggers
"subscription audit", "find my subscriptions", "what am I paying for", "audit recurring charges"

## Steps
1. Search Gmail for recurring-charge signals:
   - "subscription", "renewal", "auto-renew", "monthly payment", "annual subscription"
   - "your receipt", "invoice", "billing"
   - Common providers: streaming services, music, cloud storage, software/SaaS, gym, insurance, etc.
2. For each match, extract:
   - Vendor name
   - Amount
   - Frequency (monthly/annual)
   - Last charge date
   - Cancellation difficulty (if known)
3. Cross-reference with `memory/long-term/financial-snapshot.md` (recurring outflows section).
4. Flag any:
   - Charges not in the financial snapshot
   - Mystery charges (unknown or unexpected)
   - Duplicates (paying for same thing twice)
   - Forgotten subscriptions (not used in 6+ months based on activity)

## Output
Table format:
| Vendor | Amount | Freq | Last charge | Notes |

## After audit
Suggest cancellations. Update `memory/long-term/financial-snapshot.md` with confirmed recurring charges.
