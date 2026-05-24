import { ingest } from '../../../brain/memory/ingest.ts';
import type { Integration, IntegrationContext } from '../../_runtime/types.ts';

// Yahoo killed v7/quote for non-browser UAs in 2025 — returns 401 for unknown
// UAs and 429 for browser UAs without a session crumb cookie. The v8/chart
// endpoint still serves price data without auth or cookies; `meta` on each
// result has the same fields we previously read from quoteResponse.result.
// Trade-off: one request per symbol instead of one batched request, but Yahoo's
// per-IP throughput easily handles our handful of tickers.
const CHART_URL = 'https://query1.finance.yahoo.com/v8/finance/chart';
// GOOG is included by default as a reference equity alongside the index ETFs.
// Override the full ticker list via the `tickers` key in integration state.
const DEFAULT_TICKERS = ['GOOG', 'SPY', 'QQQ', 'BTC-USD'];

interface Quote {
  symbol: string;
  regularMarketPrice?: number;
  regularMarketChange?: number;
  regularMarketChangePercent?: number;
  shortName?: string;
  longName?: string;
}

interface ChartMeta {
  symbol?: string;
  regularMarketPrice?: number;
  chartPreviousClose?: number;
  previousClose?: number;
  shortName?: string;
  longName?: string;
}

interface ChartResponse {
  chart: {
    result?: Array<{
      meta: ChartMeta;
      timestamp: number[];
      indicators: {
        quote: Array<{
          open: number[];
          high: number[];
          low: number[];
          close: number[];
          volume: number[];
        }>;
      };
    }>;
    error?: unknown;
  };
}

function getTickers(ctx: IntegrationContext): string[] {
  const raw = ctx.state.get('tickers');
  if (raw) {
    try {
      return JSON.parse(raw) as string[];
    } catch {
      /* fall through */
    }
  }
  return DEFAULT_TICKERS;
}

async function fetchQuote(ctx: IntegrationContext, symbol: string): Promise<Quote | null> {
  // range=1d&interval=1d gives a single bar (today's session) which is enough
  // to read meta.regularMarketPrice. Larger ranges work but waste payload.
  const url = `${CHART_URL}/${encodeURIComponent(symbol)}?range=1d&interval=1d`;
  const res = await ctx.fetch(url, { headers: { 'User-Agent': 'robin-assistant' } });
  if (!res.ok) throw new Error(`yahoo chart ${symbol} returned ${res.status}`);
  const data = (await res.json()) as ChartResponse;
  const meta = data.chart.result?.[0]?.meta;
  if (!meta || meta.regularMarketPrice == null) return null;
  // chart endpoint doesn't expose change/changePercent directly; derive from
  // chartPreviousClose. previousClose may also exist but is unreliable for
  // crypto and after-hours — chartPreviousClose is the value chart UIs use.
  const prev = meta.chartPreviousClose ?? meta.previousClose;
  const change = prev != null ? meta.regularMarketPrice - prev : undefined;
  const changePct =
    prev != null && prev !== 0 ? ((meta.regularMarketPrice - prev) / prev) * 100 : undefined;
  return {
    symbol: meta.symbol ?? symbol,
    regularMarketPrice: meta.regularMarketPrice,
    regularMarketChange: change,
    regularMarketChangePercent: changePct,
    shortName: meta.shortName,
    longName: meta.longName,
  };
}

async function fetchQuotes(ctx: IntegrationContext, symbols: string[]): Promise<Quote[]> {
  // Parallel — Yahoo handles a handful of concurrent chart requests fine, and the
  // tick latency drops from N×roundtrip to one roundtrip. If we ever ticker > 20
  // symbols a Promise.all this wide could hit rate limits; not a problem today.
  const settled = await Promise.allSettled(symbols.map((s) => fetchQuote(ctx, s)));
  const out: Quote[] = [];
  for (const r of settled) {
    if (r.status === 'fulfilled' && r.value) out.push(r.value);
  }
  return out;
}

export const integration: Integration = {
  async tick(ctx) {
    const tickers = getTickers(ctx);
    if (!tickers.length) return { status: 'skipped', message: 'no tickers configured' };
    let quotes: Quote[];
    try {
      quotes = await fetchQuotes(ctx, tickers);
    } catch (err) {
      return { status: 'error', message: err instanceof Error ? err.message : String(err) };
    }
    let ingested = 0;
    for (const q of quotes) {
      if (q.regularMarketPrice == null) continue;
      const summary = `${q.symbol}: $${q.regularMarketPrice.toFixed(2)} (${q.regularMarketChangePercent?.toFixed(2) ?? '?'}%)`;
      await ingest(ctx.db, ctx.llm, {
        kind: 'integration.finance_quote.tick',
        source: 'finance_quote',
        content: summary,
        payload: {
          symbol: q.symbol,
          price: q.regularMarketPrice,
          change_pct: q.regularMarketChangePercent,
          name: q.shortName ?? q.longName,
        },
      });
      ingested++;
    }
    ctx.state.set('last_sync', ctx.now().toISOString());
    return { status: 'ok', ingested };
  },

  async health(ctx) {
    const last = ctx.state.get('last_sync');
    return { ok: true, message: last ? `last sync: ${last}` : 'never synced' };
  },
};

export const actions = {
  async quote_latest(params: { symbols: string[] }, ctx: IntegrationContext): Promise<Quote[]> {
    return fetchQuotes(ctx, params.symbols);
  },
  async history(
    params: { symbol: string; range?: string },
    ctx: IntegrationContext,
  ): Promise<{
    symbol: string;
    bars: Array<{ ts: number; o: number; h: number; l: number; c: number; v: number }>;
  }> {
    const range = params.range ?? '1mo';
    const res = await ctx.fetch(
      `${CHART_URL}/${encodeURIComponent(params.symbol)}?range=${range}&interval=1d`,
      { headers: { 'User-Agent': 'robin-assistant' } },
    );
    if (!res.ok) throw new Error(`yahoo chart returned ${res.status}`);
    const data = (await res.json()) as ChartResponse;
    const result = data.chart.result?.[0];
    if (!result) return { symbol: params.symbol, bars: [] };
    const quote = result.indicators.quote[0];
    const bars = result.timestamp.map((ts, i) => ({
      ts,
      o: quote.open[i],
      h: quote.high[i],
      l: quote.low[i],
      c: quote.close[i],
      v: quote.volume[i],
    }));
    return { symbol: params.symbol, bars };
  },
};
