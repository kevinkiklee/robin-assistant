import { buildEventFromQuote, fetchQuote, parseTickers } from './client.js';

export async function sync(ctx) {
  const tickers = parseTickers(process.env.FINANCE_QUOTE_TICKERS);
  const events = [];
  const errors = [];
  for (const ticker of tickers) {
    try {
      const quote = await fetchQuote({
        ticker,
        fetchFn: ctx.fetchFn,
        signal: ctx.signal,
        log: ctx.log,
      });
      events.push(buildEventFromQuote(quote, ticker));
    } catch (e) {
      ctx.log?.(`finance_quote: ${ticker} failed: ${e.message}`);
      errors.push({ ticker, error: e.message });
    }
  }
  if (events.length > 0) await ctx.capture(events);
  return {
    count: events.length,
    cursor: { last_run_at: new Date().toISOString(), errors },
  };
}
