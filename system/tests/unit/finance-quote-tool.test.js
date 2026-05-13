import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { writeConfig as __robinWriteConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createFinanceQuoteLatestTool } from '../../io/integrations/finance_quote/tools/finance-quote-latest.js';

const __robinTestHome = __robinJoin(
  __robinTmpdir(),
  `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
);
__robinMkdirSync(__robinTestHome, { recursive: true });
process.env.ROBIN_HOME = __robinTestHome;
await __robinWriteConfig({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  return db;
}

async function seedQuote(db, { ticker, last, prev, asOf }) {
  await db
    .query(
      surql`CREATE events CONTENT ${{
        source: 'finance_quote',
        content: `${ticker} · $${last} · as of ${asOf}`,
        ts: new Date(`${asOf}T20:00:00Z`),
        meta: { ticker, last, prev_close: prev, as_of: asOf, source: 'yahoo-finance' },
      }}`,
    )
    .collect();
}

test('finance_quote_latest returns most recent quote for a ticker', async () => {
  const db = await fresh();
  await seedQuote(db, { ticker: 'GOOG', last: 143.73, prev: 140, asOf: '2026-05-10' });
  await seedQuote(db, { ticker: 'GOOG', last: 145.23, prev: 143.73, asOf: '2026-05-11' });
  await seedQuote(db, { ticker: 'AAPL', last: 230, prev: 228, asOf: '2026-05-11' });
  const t = createFinanceQuoteLatestTool({ db });
  const r = await t.handler({ ticker: 'GOOG' });
  assert.equal(r.quote.meta.ticker, 'GOOG');
  assert.equal(r.quote.meta.last, 145.23);
  await close(db);
});

test('finance_quote_latest returns null when no quotes exist for ticker', async () => {
  const db = await fresh();
  const t = createFinanceQuoteLatestTool({ db });
  const r = await t.handler({ ticker: 'GOOG' });
  assert.equal(r.quote, null);
  await close(db);
});

test('finance_quote_latest returns one quote per ticker when no ticker filter', async () => {
  const db = await fresh();
  await seedQuote(db, { ticker: 'GOOG', last: 145, prev: 143, asOf: '2026-05-11' });
  await seedQuote(db, { ticker: 'AAPL', last: 230, prev: 228, asOf: '2026-05-11' });
  const t = createFinanceQuoteLatestTool({ db });
  const r = await t.handler({});
  assert.equal(r.quotes.length, 2);
  const tickers = r.quotes.map((q) => q.meta.ticker).sort();
  assert.deepEqual(tickers, ['AAPL', 'GOOG']);
  await close(db);
});
