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

test('finance_quote: tick fetches default watchlist and ingests quotes', async () => {
  const db = freshDb();
  const ctx = buildContext('finance_quote', db, null);
  ctx.fetch = (async (url: string) => {
    if (url.includes('/v7/finance/quote')) {
      return new Response(
        JSON.stringify({
          quoteResponse: {
            result: [
              {
                symbol: 'SPY',
                regularMarketPrice: 500.12,
                regularMarketChange: 1.23,
                regularMarketChangePercent: 0.25,
                shortName: 'SPDR S&P 500',
              },
              { symbol: 'BTC-USD', regularMarketPrice: 65000, regularMarketChangePercent: -1.5 },
            ],
          },
        }),
        { status: 200 },
      );
    }
    return new Response('', { status: 404 });
  }) as typeof fetch;
  assert.ok(fin.tick);
  const r = await fin.tick(ctx);
  assert.equal(r.status, 'ok');
  assert.equal(r.ingested, 2);
  const rows = db.prepare("SELECT body FROM events_content WHERE body LIKE 'SPY%'").all() as Array<{
    body: string;
  }>;
  assert.equal(rows.length, 1);
  closeDb(db);
});

test('finance_quote: tick respects custom watchlist in state KV', async () => {
  const db = freshDb();
  const ctx = buildContext('finance_quote', db, null);
  ctx.state.set('tickers', JSON.stringify(['AAPL', 'MSFT']));
  let requestedSymbols = '';
  ctx.fetch = (async (url: string) => {
    requestedSymbols = new URL(url).searchParams.get('symbols') ?? '';
    return new Response(
      JSON.stringify({
        quoteResponse: {
          result: [
            { symbol: 'AAPL', regularMarketPrice: 200 },
            { symbol: 'MSFT', regularMarketPrice: 400 },
          ],
        },
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  assert.ok(fin.tick);
  await fin.tick(ctx);
  assert.equal(requestedSymbols, 'AAPL,MSFT');
  closeDb(db);
});

test('finance_quote: tick returns error on non-OK fetch', async () => {
  const db = freshDb();
  const ctx = buildContext('finance_quote', db, null);
  ctx.fetch = (async () => new Response('rate limit', { status: 429 })) as typeof fetch;
  assert.ok(fin.tick);
  const r = await fin.tick(ctx);
  assert.equal(r.status, 'error');
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
