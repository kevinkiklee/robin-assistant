import assert from 'node:assert/strict';
import { test } from 'node:test';
import { estimateCostUsd, priceFor } from './pricing.ts';

test('priceFor: maps model ids to list price, defaulting to Opus 5.5', () => {
  assert.deepEqual(priceFor('claude-opus-5-5'), { input: 4, output: 20 });
  assert.deepEqual(priceFor('claude-opus-5-5[1m]'), { input: 4, output: 20 });
  assert.deepEqual(priceFor('claude-opus-4-8'), { input: 5, output: 25 });
  assert.deepEqual(priceFor('claude-opus-4-1-20250805'), { input: 15, output: 75 });
  assert.deepEqual(priceFor('claude-sonnet-5-5'), { input: 2, output: 10 });
  assert.deepEqual(priceFor('claude-sonnet-4-6'), { input: 3, output: 15 });
  assert.deepEqual(priceFor('claude-haiku-5-5'), { input: 0.1, output: 0.5 });
  assert.deepEqual(priceFor('claude-haiku-4-5-20251001'), { input: 1, output: 5 });
  assert.deepEqual(priceFor('claude-fable-5'), { input: 10, output: 50 });
  assert.deepEqual(priceFor(undefined), { input: 4, output: 20 });
  assert.deepEqual(priceFor('some-new-model'), { input: 4, output: 20 });
});

test('estimateCostUsd: reproduces a live SDK modelUsage cost (opus-4-8, 2026-10-03)', () => {
  const usd = estimateCostUsd('claude-opus-4-8', {
    inputTokens: 4,
    cacheWriteTokens: 30_987,
    cacheReadTokens: 48_344,
    outputTokens: 3_920,
  });
  // The SDK reported costUSD 0.315860749 for these counts.
  assert.ok(Math.abs(usd - 0.315860749) < 1e-6, `got ${usd}`);
});
