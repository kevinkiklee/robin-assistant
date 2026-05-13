import { sync } from './sync.js';
import { createFinanceQuoteLatestTool } from './tools/finance-quote-latest.js';

// Public unauthenticated API (Yahoo Finance primary, Stooq fallback).
// Configure tickers via FINANCE_QUOTE_TICKERS env (comma-separated, default GOOG).
//
// `capture_mode: 'upsert'` so multiple intraday fires for the same trading
// day refresh the row in place rather than dedup-skipping (Yahoo's
// `regularMarketPrice` ticks through the session).
//
// `quiet_window` gates fires to NYSE local hours (9-16) so we don't burn
// fetches overnight when prices won't move.
export const manifest = {
  name: 'finance_quote',
  cadence: '30m',
  embed: true,
  capture_mode: 'upsert',
  secrets: { env_keys: [] },
  quiet_window: { tz: 'America/New_York', active_hours: [9, 10, 11, 12, 13, 14, 15, 16] },
  sync,
  tools: [createFinanceQuoteLatestTool],
};
