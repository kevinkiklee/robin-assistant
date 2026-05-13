import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import {
  buildEventFromQuote,
  fetchQuote,
  parseStooqCsv,
  parseTickers,
  parseYahooResponse,
} from '../../io/integrations/finance_quote/client.js';
import { sync } from '../../io/integrations/finance_quote/sync.js';

const yahooFixture = {
  chart: {
    result: [
      {
        meta: {
          regularMarketPrice: 145.23,
          chartPreviousClose: 143.73,
          currency: 'USD',
          fiftyTwoWeekHigh: 200.0,
          fiftyTwoWeekLow: 110.0,
        },
        timestamp: [1715472000, 1715558400, 1715644800],
        indicators: { quote: [{ close: [140.1, 143.73, 145.23] }] },
      },
    ],
  },
};

const stooqFixture =
  'Symbol,Date,Time,Open,High,Low,Close,Volume,Prev,Turnover\nGOOG.US,2026-05-12,22:00:00,144,146,143,145.23,1234567,143.73,0\n';

test('parseTickers defaults to GOOG for empty input', () => {
  assert.deepEqual(parseTickers(''), ['GOOG']);
  assert.deepEqual(parseTickers(undefined), ['GOOG']);
});

test('parseTickers splits comma-separated symbols, uppercases, trims', () => {
  assert.deepEqual(parseTickers('aapl, msft ,goog'), ['AAPL', 'MSFT', 'GOOG']);
});

test('parseYahooResponse extracts last / prev / asOf from chart payload', () => {
  const q = parseYahooResponse(yahooFixture);
  assert.equal(q.source, 'yahoo-finance');
  assert.equal(q.last, 145.23);
  assert.equal(q.prev, 143.73);
  assert.equal(q.currency, 'USD');
  assert.equal(q.fiftyTwoWeekHigh, 200);
  assert.match(q.asOf, /^\d{4}-\d{2}-\d{2}$/);
});

test('parseYahooResponse throws on empty result', () => {
  assert.throws(() => parseYahooResponse({ chart: { result: [] } }), /empty/i);
});

test('parseStooqCsv pulls close + prev from CSV row', () => {
  const q = parseStooqCsv(stooqFixture);
  assert.equal(q.source, 'stooq');
  assert.equal(q.last, 145.23);
  assert.equal(q.prev, 143.73);
  assert.equal(q.asOf, '2026-05-12');
});

test('parseStooqCsv throws on header-only / empty body', () => {
  assert.throws(() => parseStooqCsv('Symbol,Date\n'), /empty|bad/i);
});

test('fetchQuote uses yahoo on success', async () => {
  const fetchFn = mock.fn(async () => ({ ok: true, json: async () => yahooFixture }));
  const q = await fetchQuote({ ticker: 'GOOG', fetchFn });
  assert.equal(q.source, 'yahoo-finance');
  assert.equal(fetchFn.mock.callCount(), 1);
});

test('fetchQuote falls back to stooq when yahoo errors', async () => {
  let call = 0;
  const fetchFn = mock.fn(async () => {
    call += 1;
    if (call === 1) return { ok: false, status: 401, json: async () => ({}) };
    return { ok: true, text: async () => stooqFixture };
  });
  const q = await fetchQuote({ ticker: 'GOOG', fetchFn });
  assert.equal(q.source, 'stooq');
  assert.equal(fetchFn.mock.callCount(), 2);
});

test('buildEventFromQuote shapes content + meta + external_id', () => {
  const quote = {
    source: 'yahoo-finance',
    last: 145.23,
    prev: 143.73,
    asOf: '2026-05-12',
    currency: 'USD',
    fiftyTwoWeekHigh: 200,
    fiftyTwoWeekLow: 110,
  };
  const e = buildEventFromQuote(quote, 'GOOG');
  assert.equal(e.source, 'finance_quote');
  assert.equal(e.external_id, 'finance_quote:GOOG:2026-05-12');
  assert.match(e.content, /GOOG/);
  assert.match(e.content, /145\.23/);
  assert.match(e.content, /▲|▼/);
  assert.equal(e.meta.ticker, 'GOOG');
  assert.equal(e.meta.last, 145.23);
  assert.equal(e.meta.prev_close, 143.73);
  assert.ok(Math.abs(e.meta.change - 1.5) < 1e-6);
  assert.ok(e.meta.change_pct > 1 && e.meta.change_pct < 1.1);
  assert.equal(e.meta.source, 'yahoo-finance');
});

test('buildEventFromQuote handles missing prev_close gracefully', () => {
  const e = buildEventFromQuote(
    { source: 'stooq', last: 145.23, prev: null, asOf: '2026-05-12', currency: 'USD' },
    'GOOG',
  );
  assert.equal(e.meta.change, null);
  assert.equal(e.meta.change_pct, null);
  assert.doesNotMatch(e.content, /▲|▼/);
});

test('sync captures one event per configured ticker', async () => {
  const fetchFn = mock.fn(async () => ({ ok: true, json: async () => yahooFixture }));
  const captured = [];
  process.env.FINANCE_QUOTE_TICKERS = 'GOOG,AAPL';
  try {
    const r = await sync({
      secrets: {},
      log: () => {},
      cursor: null,
      capture: async (rows) => {
        captured.push(...rows);
      },
      fetchFn,
    });
    assert.equal(r.count, 2);
    assert.equal(captured.length, 2);
    assert.deepEqual(captured.map((e) => e.meta.ticker).sort(), ['AAPL', 'GOOG']);
  } finally {
    delete process.env.FINANCE_QUOTE_TICKERS;
  }
});

test('sync continues after one ticker fails', async () => {
  let call = 0;
  const fetchFn = mock.fn(async () => {
    call += 1;
    if (call <= 2) {
      // GOOG: yahoo + stooq both fail
      return { ok: false, status: 500, json: async () => ({}), text: async () => '' };
    }
    // AAPL: yahoo ok
    return { ok: true, json: async () => yahooFixture };
  });
  const captured = [];
  process.env.FINANCE_QUOTE_TICKERS = 'GOOG,AAPL';
  try {
    const r = await sync({
      secrets: {},
      log: () => {},
      cursor: null,
      capture: async (rows) => {
        captured.push(...rows);
      },
      fetchFn,
    });
    assert.equal(r.count, 1);
    assert.equal(captured.length, 1);
    assert.equal(captured[0].meta.ticker, 'AAPL');
  } finally {
    delete process.env.FINANCE_QUOTE_TICKERS;
  }
});
