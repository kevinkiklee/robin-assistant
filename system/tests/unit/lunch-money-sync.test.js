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

test('transactionToEvent shapes content + meta', () => {
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
  assert.equal(e.external_id, '5');
  assert.match(e.content, /Coffee/);
  assert.match(e.content, /\$12\.50/);
  assert.equal(e.meta.payee, 'Coffee');
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
