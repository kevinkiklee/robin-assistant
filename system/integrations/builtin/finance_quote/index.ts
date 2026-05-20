import { ingest } from '../../../brain/memory/ingest.ts';
import type { Integration, IntegrationContext } from '../../_runtime/types.ts';

const QUOTE_URL = 'https://query1.finance.yahoo.com/v7/finance/quote';
const CHART_URL = 'https://query1.finance.yahoo.com/v8/finance/chart';
const DEFAULT_TICKERS = ['SPY', 'QQQ', 'BTC-USD'];

interface Quote {
  symbol: string;
  regularMarketPrice?: number;
  regularMarketChange?: number;
  regularMarketChangePercent?: number;
  shortName?: string;
  longName?: string;
}

interface QuoteResponse {
  quoteResponse?: { result?: Quote[]; error?: unknown };
}

interface ChartResponse {
  chart: {
    result?: Array<{
      meta: { symbol: string };
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

async function fetchQuotes(ctx: IntegrationContext, symbols: string[]): Promise<Quote[]> {
  const url = `${QUOTE_URL}?symbols=${encodeURIComponent(symbols.join(','))}`;
  const res = await ctx.fetch(url, { headers: { 'User-Agent': 'robin-assistant' } });
  if (!res.ok) throw new Error(`yahoo quote returned ${res.status}`);
  const data = (await res.json()) as QuoteResponse;
  return data.quoteResponse?.result ?? [];
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
