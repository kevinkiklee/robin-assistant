import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { rollingStartDate, transactionToEvent } from '../../io/integrations/lunch_money/client.js';
import { sync } from '../../io/integrations/lunch_money/sync.js';

test('rollingStartDate returns saved cursor when within 14d', () => {
  const today = new Date('2026-05-09T00:00:00Z');
  const r = rollingStartDate('2026-05-05', today);
  assert.equal(r, '2026-05-05');
});

test('rollingStartDate clamps to today−14d when cursor older', () => {
  const today = new Date('2026-05-09T00:00:00Z');
  const r = rollingStartDate('2026-04-01', today);
  assert.equal(r, '2026-04-25');
});

test('rollingStartDate uses today−14d when no cursor', () => {
  const today = new Date('2026-05-09T00:00:00Z');
  const r = rollingStartDate(null, today);
  assert.equal(r, '2026-04-25');
});

test('transactionToEvent shapes content + meta; manual rows keep an LM-id key', () => {
  const t = {
    id: 5,
    amount: '12.50',
    payee: 'Coffee',
    category_name: 'Food',
    date: '2026-05-09',
    is_income: false,
    currency: 'USD',
  };
  const e = transactionToEvent(t);
  assert.equal(e.source, 'lunch_money');
  // No Plaid metadata + no plaid_account_id → fall back to raw LM id.
  assert.equal(e.external_id, 'lm:5');
  assert.match(e.content, /Coffee/);
  assert.match(e.content, /\$12\.50/);
  assert.equal(e.meta.payee, 'Coffee');
  assert.equal(e.meta.lm_id, 5);
});

test('transactionToEvent dedup key: pending and cleared map to the same external_id', () => {
  // Same upstream Plaid transaction observed twice: first while pending
  // (LM mints id=1001), then after it clears (LM mints id=1002). Plaid's
  // transaction_id stays constant across the lifecycle, so the dedup key
  // should too — and a second capture must replace the first row.
  const plaidTxId = 'plaid-tx-abc-123';
  const base = {
    amount: '919.95',
    payee: 'Bread Financial',
    original_name: 'BREAD FINANCIAL PYMT',
    category_name: null,
    date: '2026-05-12',
    is_income: false,
    currency: 'USD',
    plaid_account_id: 394031,
    plaid_metadata: { transaction_id: plaidTxId, account_id: 'plaid-acct-xyz' },
  };
  const pending = transactionToEvent({ ...base, id: 1001, status: 'uncleared' });
  const cleared = transactionToEvent({ ...base, id: 1002, status: 'cleared' });
  assert.equal(pending.external_id, `plaid:${plaidTxId}`);
  assert.equal(cleared.external_id, `plaid:${plaidTxId}`);
  // Meta still carries the latest LM id for traceability.
  assert.equal(pending.meta.lm_id, 1001);
  assert.equal(cleared.meta.lm_id, 1002);
});

test('transactionToEvent stable composite key when no Plaid transaction_id is present', () => {
  // Older Plaid rows or LM snapshots may have plaid_account_id but no
  // plaid_metadata.transaction_id. Composite of (date, account, amount,
  // original_name) must still dedupe pending vs cleared.
  const base = {
    amount: '38.09',
    payee: 'Netflix',
    original_name: 'NETFLIX.COM',
    category_name: 'Entertainment',
    date: '2026-05-12',
    is_income: false,
    currency: 'USD',
    plaid_account_id: 394029,
  };
  const a = transactionToEvent({ ...base, id: 2001 });
  const b = transactionToEvent({ ...base, id: 2002 });
  assert.equal(a.external_id, b.external_id);
  assert.match(a.external_id, /^lm-stable:2026-05-12\|394029\|38\.09\|netflix\.com$/);
});

test('transactionToEvent handles plaid_metadata as a stringified JSON blob', () => {
  // LM has historically serialized plaid_metadata as a JSON string in
  // some responses. transactionToEvent must parse it before reading
  // transaction_id; otherwise the stable id would fall through.
  const t = {
    id: 7,
    amount: '5',
    payee: 'X',
    date: '2026-05-12',
    is_income: false,
    plaid_account_id: 1,
    plaid_metadata: JSON.stringify({ transaction_id: 'plaid-7' }),
  };
  const e = transactionToEvent(t);
  assert.equal(e.external_id, 'plaid:plaid-7');
});

test('sync calls API and returns count + cursor', async () => {
  const fetchFn = mock.fn(async () => ({
    ok: true,
    json: async () => ({
      transactions: [
        {
          id: 1,
          amount: '10',
          date: '2026-05-09',
          is_income: false,
          payee: 'X',
          category_name: 'Y',
          currency: 'USD',
        },
        {
          id: 2,
          amount: '20',
          date: '2026-05-08',
          is_income: false,
          payee: 'Z',
          category_name: 'Y',
          currency: 'USD',
        },
      ],
    }),
  }));
  const captured = [];
  const r = await sync({
    secrets: { LUNCH_MONEY_API_KEY: 'k' },
    log: () => {},
    cursor: null,
    capture: async (rows) => {
      captured.push(...rows);
      return {};
    },
    fetchFn,
  });
  assert.equal(r.count, 2);
  assert.match(r.cursor.start_date, /^\d{4}-\d{2}-\d{2}$/);
});
