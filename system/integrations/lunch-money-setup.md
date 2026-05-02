# Lunch Money setup — finance sync

Lunch Money is a personal finance aggregator (https://lunchmoney.app).
Robin pulls your transactions, accounts, categories, and budget so that
finance-aware protocols (monthly summary, subscription audit) have local
data to work with.

## 1. Get an API key

1. Sign in to Lunch Money.
2. Open **Developers**: https://my.lunchmoney.app/developers
3. **Create a new access token** with whatever name you like.
4. Copy the value (shown only once).

## 2. Add to `.env`

```env
LUNCH_MONEY_API_KEY=<your-token>
```

## 3. Bootstrap and enable

```sh
node user-data/ops/scripts/sync-lunch-money.js --bootstrap
node bin/robin.js jobs enable sync-lunch-money
```

Default schedule: daily at 01:00 local time.

## What gets synced

Under `user-data/memory/knowledge/finance/lunch-money/`:

- `transactions.md` — recent transactions, with category, account, notes
- `accounts.md` — connected accounts and current balances
- `budgets.md` — current month budget by category

There's no OAuth flow — Lunch Money uses a simple bearer token. There are
no known endpoint restrictions or deprecations.
