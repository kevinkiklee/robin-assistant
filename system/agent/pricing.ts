/**
 * List-price estimate for an SDK run that never delivered its `result` message
 * (deadline abort, mid-stream throw). The SDK's `total_cost_usd` is the
 * authoritative figure and always wins when present; this exists so a timed-out
 * run books its best-known spend instead of $0 (27 timeout rows were booked at
 * $0 before this, 2026-10).
 *
 * USD per million tokens. Cache writes bill at 1.25× input, cache reads at
 * 0.1× — verified against a live agent-runs transcript (opus-4-8, 2026-10-03:
 * 4 in / 30,987 cache-write / 48,344 cache-read / 3,920 out → $0.3159, matching
 * the SDK's modelUsage costUSD).
 */
interface ModelPrice {
  input: number;
  output: number;
}

const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.1;

// Ordered: first match wins. Unknown models fall back to the agentic default
// (Opus 5.5), which is what an unpinned run uses.
const PRICES: Array<[RegExp, ModelPrice]> = [
  [/fable/i, { input: 10, output: 50 }],
  [/opus-5-5/i, { input: 4, output: 20 }],
  [/opus-4-(?:0|1)\b|opus-4(?:-\d{8})?$|claude-3-opus/i, { input: 15, output: 75 }],
  [/opus/i, { input: 5, output: 25 }],
  [/sonnet-5/i, { input: 2, output: 10 }],
  [/sonnet/i, { input: 3, output: 15 }],
  [/haiku-3|3-5-haiku|3-haiku/i, { input: 0.8, output: 4 }],
  // Haiku 5.5 list price is for prompts ≤100K tokens ($0.50/$2.50 beyond).
  [/haiku-5/i, { input: 0.1, output: 0.5 }],
  [/haiku/i, { input: 1, output: 5 }],
];
const DEFAULT_PRICE: ModelPrice = { input: 4, output: 20 };

export function priceFor(model: string | undefined): ModelPrice {
  if (model) {
    for (const [re, price] of PRICES) if (re.test(model)) return price;
  }
  return DEFAULT_PRICE;
}

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/** Estimated USD for one model's token counts at list price. */
export function estimateCostUsd(model: string | undefined, t: TokenCounts): number {
  const p = priceFor(model);
  return (
    (t.inputTokens * p.input +
      (t.cacheWriteTokens ?? 0) * p.input * CACHE_WRITE_MULTIPLIER +
      (t.cacheReadTokens ?? 0) * p.input * CACHE_READ_MULTIPLIER +
      t.outputTokens * p.output) /
    1_000_000
  );
}
