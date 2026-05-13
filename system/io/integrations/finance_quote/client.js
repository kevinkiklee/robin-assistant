// finance_quote client. Yahoo Finance primary, Stooq fallback. No auth.
//
// Yahoo's chart endpoint returns 401 to a bare fetch — needs a browser-like
// UA. Both endpoints are unauthenticated otherwise.

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const TZ = 'America/New_York';

export function parseTickers(envStr) {
  const raw = (envStr ?? '').trim();
  if (!raw) return ['GOOG'];
  const out = raw
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  return out.length > 0 ? out : ['GOOG'];
}

function fmtDate(d) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function parseYahooResponse(json) {
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error('yahoo: empty result');
  const meta = result.meta ?? {};
  const closes = result.indicators?.quote?.[0]?.close ?? [];
  const cleanCloses = closes.filter((v) => typeof v === 'number');
  if (cleanCloses.length < 1) throw new Error('yahoo: no closes');
  const last =
    typeof meta.regularMarketPrice === 'number' ? meta.regularMarketPrice : cleanCloses.at(-1);
  const prev =
    typeof meta.chartPreviousClose === 'number'
      ? meta.chartPreviousClose
      : cleanCloses.length >= 2
        ? cleanCloses.at(-2)
        : null;
  const timestamps = result.timestamp ?? [];
  const lastIdx = closes.lastIndexOf(last);
  const asOfTs =
    lastIdx >= 0 && timestamps[lastIdx] ? new Date(timestamps[lastIdx] * 1000) : new Date();
  return {
    source: 'yahoo-finance',
    last,
    prev,
    asOf: fmtDate(asOfTs),
    fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh ?? null,
    fiftyTwoWeekLow: meta.fiftyTwoWeekLow ?? null,
    currency: meta.currency ?? 'USD',
  };
}

export function parseStooqCsv(text) {
  const lines = (text ?? '').trim().split(/\r?\n/);
  if (lines.length < 2) throw new Error('stooq: empty');
  const cols = lines[1].split(',');
  const close = Number.parseFloat(cols[6]);
  const prev = Number.parseFloat(cols[8]);
  if (!Number.isFinite(close)) throw new Error('stooq: bad close');
  return {
    source: 'stooq',
    last: close,
    prev: Number.isFinite(prev) ? prev : null,
    asOf: cols[1] || fmtDate(new Date()),
    fiftyTwoWeekHigh: null,
    fiftyTwoWeekLow: null,
    currency: 'USD',
  };
}

export async function fetchYahoo({ ticker, fetchFn = globalThis.fetch, signal }) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=5d&interval=1d`;
  const res = await fetchFn(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal,
  });
  if (!res.ok) throw new Error(`yahoo HTTP ${res.status}`);
  return parseYahooResponse(await res.json());
}

export async function fetchStooq({ ticker, fetchFn = globalThis.fetch, signal }) {
  // sd2t2ohlcvpr → Symbol,Date,Time,Open,High,Low,Close,Volume,Prev,Turnover.
  const url = `https://stooq.com/q/l/?s=${ticker.toLowerCase()}.us&f=sd2t2ohlcvpr&h&e=csv`;
  const res = await fetchFn(url, { headers: { 'User-Agent': UA }, signal });
  if (!res.ok) throw new Error(`stooq HTTP ${res.status}`);
  return parseStooqCsv(await res.text());
}

export async function fetchQuote({ ticker, fetchFn = globalThis.fetch, signal, log = () => {} }) {
  try {
    return await fetchYahoo({ ticker, fetchFn, signal });
  } catch (e) {
    log(`yahoo failed for ${ticker} (${e.message}); falling back to stooq`);
    return await fetchStooq({ ticker, fetchFn, signal });
  }
}

export function buildEventFromQuote(quote, ticker) {
  const change =
    Number.isFinite(quote.last) && Number.isFinite(quote.prev) ? quote.last - quote.prev : null;
  const changePct =
    change !== null && Number.isFinite(quote.prev) && quote.prev !== 0
      ? (change / quote.prev) * 100
      : null;
  const arrow = change === null ? '' : change >= 0 ? '▲' : '▼';
  const lastStr = Number.isFinite(quote.last) ? quote.last.toFixed(2) : '—';
  const changeStr =
    change === null ? '' : ` · ${arrow} $${Math.abs(change).toFixed(2)} (${changePct.toFixed(2)}%)`;
  const content = `${ticker} · $${lastStr}${changeStr} · as of ${quote.asOf}`;
  return {
    source: 'finance_quote',
    content,
    // Use ~US market close in UTC so ts sorts by trading day, not fetch time.
    ts: new Date(`${quote.asOf}T20:00:00Z`),
    external_id: `finance_quote:${ticker}:${quote.asOf}`,
    meta: {
      ticker,
      last: quote.last,
      prev_close: quote.prev,
      change,
      change_pct: changePct,
      as_of: quote.asOf,
      currency: quote.currency,
      fifty_two_week_high: quote.fiftyTwoWeekHigh,
      fifty_two_week_low: quote.fiftyTwoWeekLow,
      source: quote.source,
    },
  };
}
