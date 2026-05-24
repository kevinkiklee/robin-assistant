import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TimeoutError } from '../../lib/with-timeout.ts';
import { LLMDispatcher, SpendCapError } from './dispatcher.ts';
import type { LLMProvider } from './types.ts';

function mockProvider(name: string, text: string, costUsd = 0): LLMProvider {
  return {
    name,
    capabilities: new Set(['classify']),
    meta: { contextWindow: 4096, inputPricePerM: 0, outputPricePerM: 0 },
    invoke: async () => ({
      text,
      usage: { inputTokens: 0, outputTokens: 0 },
      costUsd,
      latencyMs: 0,
      provider: name,
    }),
  };
}

test('dispatcher: routes role to assigned provider', async () => {
  const d = new LLMDispatcher();
  d.register('p1', mockProvider('p1', 'from p1'));
  d.register('p2', mockProvider('p2', 'from p2'));
  d.assign('classify', 'p1');
  const r = await d.invoke('classify', { messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(r.text, 'from p1');
});

test('dispatcher: throws on unassigned role', async () => {
  const d = new LLMDispatcher();
  d.register('p1', mockProvider('p1', 'x'));
  await assert.rejects(async () => d.invoke('classify', { messages: [] }), /No provider assigned/);
});

test('dispatcher: throws when assigning unknown provider', () => {
  const d = new LLMDispatcher();
  assert.throws(() => d.assign('classify', 'nope'), /not registered/);
});

// Bug F regression — any provider call must be bounded by the dispatcher's
// default ceiling so a hung provider can't wedge the caller's awaited promise.
test('dispatcher: invoke wraps provider call with default timeout', async () => {
  const hang: LLMProvider = {
    name: 'hang',
    capabilities: new Set(['classify']),
    meta: { contextWindow: 4096, inputPricePerM: 0, outputPricePerM: 0 },
    invoke: () => new Promise(() => {}),
  };
  const d = new LLMDispatcher({ defaultInvokeTimeoutMs: 30 });
  d.register('hang', hang);
  d.assign('classify', 'hang');
  await assert.rejects(
    () => d.invoke('classify', { messages: [{ role: 'user', content: 'x' }] }),
    (err: unknown) => err instanceof TimeoutError,
  );
});

test('dispatcher: invoke honors per-request timeoutMs override', async () => {
  const hang: LLMProvider = {
    name: 'hang',
    capabilities: new Set(['classify']),
    meta: { contextWindow: 4096, inputPricePerM: 0, outputPricePerM: 0 },
    invoke: () => new Promise(() => {}),
  };
  // Default is very generous; per-request override is what bounds the call.
  const d = new LLMDispatcher({ defaultInvokeTimeoutMs: 60_000 });
  d.register('hang', hang);
  d.assign('classify', 'hang');
  const started = Date.now();
  await assert.rejects(
    () =>
      d.invoke('classify', {
        messages: [{ role: 'user', content: 'x' }],
        timeoutMs: 30,
      }),
    (err: unknown) => err instanceof TimeoutError,
  );
  // Sanity: rejected against the override, not the default.
  assert.ok(Date.now() - started < 500, 'timeout fired against override, not default');
});

// Cloud-spend safety — once the rolling daily total reaches the cap, further
// invokes throw SpendCapError (message contains "spend cap exceeded" so the
// biographer circuit breaker reads it as an outage and won't lose data).
test('dispatcher: trips SpendCapError after the daily cap is reached', async () => {
  const d = new LLMDispatcher({ dailyCostCapUsd: 1 });
  d.register('p', mockProvider('p', 'ok', 0.6)); // $0.60 per call
  d.assign('classify', 'p');

  // First two calls succeed (0 → 0.60 → 1.20); the cap is checked BEFORE each
  // call, so the third — when the prior total (1.20) ≥ 1 — is rejected.
  await d.invoke('classify', { messages: [{ role: 'user', content: 'a' }] });
  await d.invoke('classify', { messages: [{ role: 'user', content: 'b' }] });
  assert.ok(d.getDailySpendUsd() >= 1);
  await assert.rejects(
    () => d.invoke('classify', { messages: [{ role: 'user', content: 'c' }] }),
    (err: unknown) => err instanceof SpendCapError && /spend cap exceeded/i.test(err.message),
  );
});

test('dispatcher: no cap (0) never blocks and does not track spend', async () => {
  const d = new LLMDispatcher(); // cap defaults to 0 = disabled
  d.register('p', mockProvider('p', 'ok', 5));
  d.assign('classify', 'p');
  for (let i = 0; i < 5; i++) {
    await d.invoke('classify', { messages: [{ role: 'user', content: 'x' }] });
  }
  assert.equal(d.getDailySpendUsd(), 0);
});

test('dispatcher: embed wraps provider call with default timeout', async () => {
  const hang: LLMProvider = {
    name: 'embed-hang',
    capabilities: new Set(['embed']),
    meta: { contextWindow: 4096, inputPricePerM: 0, outputPricePerM: 0 },
    invoke: async () => {
      throw new Error('not used');
    },
    embed: () => new Promise(() => {}),
  };
  const d = new LLMDispatcher({ defaultEmbedTimeoutMs: 30 });
  d.register('embed-hang', hang);
  d.assign('embed', 'embed-hang');
  await assert.rejects(
    () => d.embed('embed', 'hi'),
    (err: unknown) => err instanceof TimeoutError,
  );
});
