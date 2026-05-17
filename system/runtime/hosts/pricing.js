// pricing.js — Anthropic API pricing in USD per 1M tokens.
// Update when Anthropic publishes new pricing.
export const PRICING = {
  haiku: { input: 0.80, output: 4.00 },     // claude-haiku-4-5
  sonnet: { input: 3.00, output: 15.00 },   // claude-sonnet-4-6
  opus: { input: 15.00, output: 75.00 },    // claude-opus-4-7
};

export function estimateCostUsd(tier, tokensIn, tokensOut) {
  const t = PRICING[tier] ?? PRICING.haiku;
  return (tokensIn / 1_000_000) * t.input + (tokensOut / 1_000_000) * t.output;
}
