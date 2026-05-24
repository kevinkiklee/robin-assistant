import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { closeDb, openDb } from '../../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../../brain/memory/migrations/index.ts';
import { buildContext } from '../../_runtime/context.ts';
import { actions, integration as fin } from './index.ts';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'robin-fin-'));
  mkdirSync(join(dir, 'state', 'db'), { recursive: true });
  const db = openDb(join(dir, 'state', 'db', 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

// v8/chart returns one chart-result per request, keyed off the URL path's symbol.
// Build a stub that returns price + chartPreviousClose for any symbol we care to test.
function chartResponse(symbol: string, price: number, prevClose?: number, name?: string) {
  return new Response(
    JSON.stringify({
      chart: {
        result: [
          {
            meta: {
              symbol,
              regularMarketPrice: price,
              chartPreviousClose: prevClose ?? price,
              shortName: name,
            },
            timestamp: [1_700_000_000],
            indicators: {
              quote: [{ open: [price], high: [price], low: [price], close: [price], volume: [1] }],
            },
          },
        ],
      },
    }),
    { status: 200 },
  );
}

test('finance_quote: tick fetches one chart per ticker and ingests quotes', async () => {
  const db = freshDb();
  const ctx = buildContext('finance_quote', db, null);
  const calls: string[] = [];
  ctx.fetch = (async (url: string) => {
    calls.push(url);
    if (url.includes('/GOOG')) return chartResponse('GOOG', 200.5, 198.7, 'Alphabet Inc.');
    if (url.includes('/SPY')) return chartResponse('SPY', 500.12, 498.89, 'SPDR S&P 500');
    if (url.includes('/QQQ')) return chartResponse('QQQ', 450, 449);
    if (url.includes('/BTC-USD')) return chartResponse('BTC-USD', 65000, 66000);
    return new Response('', { status: 404 });
  }) as typeof fetch;

  assert.ok(fin.tick);
  const r = await fin.tick(ctx);
  assert.equal(r.status, 'ok');
  assert.equal(r.ingested, 4);
  assert.equal(calls.length, 4, 'one chart request per default ticker');
  const rows = db.prepare("SELECT body FROM events_content WHERE body LIKE 'SPY%'").all() as Array<{
    body: string;
  }>;
  assert.equal(rows.length, 1);
  // Derived change_pct should be (500.12 - 498.89) / 498.89 * 100 ≈ 0.246
  assert.match(rows[0].body, /SPY.*\$500\.12.*0\.25%/);
  closeDb(db);
});

test('finance_quote: tick respects custom watchlist in state KV', async () => {
  const db = freshDb();
  const ctx = buildContext('finance_quote', db, null);
  ctx.state.set('tickers', JSON.stringify(['AAPL', 'MSFT']));
  const requestedSymbols: string[] = [];
  ctx.fetch = (async (url: string) => {
    // /v8/finance/chart/<SYMBOL>?...
    const m = url.match(/\/chart\/([^?]+)/);
    if (m) requestedSymbols.push(decodeURIComponent(m[1]));
    return chartResponse(decodeURIComponent(m?.[1] ?? ''), 100);
  }) as typeof fetch;
  assert.ok(fin.tick);
  await fin.tick(ctx);
  assert.deepEqual(requestedSymbols.sort(), ['AAPL', 'MSFT']);
  closeDb(db);
});

test('finance_quote: tick succeeds with empty ingested when every symbol errors', async () => {
  // Promise.allSettled means partial failures are tolerated; the integration only
  // returns status='error' when fetchQuotes itself throws (it doesn't here — individual
  // chart calls reject inside settled). This documents that contract change vs. v7
  // (where ANY 429 from the batched request killed the whole tick).
  const db = freshDb();
  const ctx = buildContext('finance_quote', db, null);
  ctx.fetch = (async () => new Response('rate limit', { status: 429 })) as typeof fetch;
  assert.ok(fin.tick);
  const r = await fin.tick(ctx);
  assert.equal(r.status, 'ok');
  assert.equal(r.ingested, 0);
  closeDb(db);
});

test('finance_quote: actions.history parses chart bars', async () => {
  const db = freshDb();
  const ctx = buildContext('finance_quote', db, null);
  ctx.fetch = (async () =>
    new Response(
      JSON.stringify({
        chart: {
          result: [
            {
              meta: { symbol: 'AAPL' },
              timestamp: [1_700_000_000, 1_700_086_400],
              indicators: {
                quote: [
                  {
                    open: [200, 201],
                    high: [205, 203],
                    low: [199, 200],
                    close: [203, 202],
                    volume: [1000, 2000],
                  },
                ],
              },
            },
          ],
        },
      }),
      { status: 200 },
    )) as typeof fetch;
  const r = await actions.history({ symbol: 'AAPL' }, ctx);
  assert.equal(r.symbol, 'AAPL');
  assert.equal(r.bars.length, 2);
  assert.equal(r.bars[0].o, 200);
  closeDb(db);
});
