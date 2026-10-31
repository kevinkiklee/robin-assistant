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

function throwingProvider(name: string, err: Error): LLMProvider {
  return {
    name,
    capabilities: new Set(['classify']),
    meta: { contextWindow: 4096, inputPricePerM: 0, outputPricePerM: 0 },
    invoke: async () => {
      throw err;
    },
  };
}

/** A mock that records whether it was invoked — to assert the fallback is/isn't hit. */
function spyProvider(name: string): { provider: LLMProvider; calls: () => number } {
  let n = 0;
  return {
    calls: () => n,
    provider: {
      name,
      capabilities: new Set(['classify']),
      meta: { contextWindow: 4096, inputPricePerM: 0, outputPricePerM: 0 },
      invoke: async () => {
        n++;
        return {
          text: `from ${name}`,
          usage: { inputTokens: 0, outputTokens: 0 },
          costUsd: 0,
          latencyMs: 0,
          provider: name,
        };
      },
    },
  };
}

test('dispatcher: falls back to the fallback provider on a usage-limit outage', async () => {
  const d = new LLMDispatcher();
  d.register(
    'sonnet',
    throwingProvider(
      'sonnet',
      new Error('subscription limit: empty completion (throttled account returned no text)'),
    ),
  );
  d.register('opus', mockProvider('opus', 'from opus'));
  d.assign('reasoning', 'sonnet');
  d.assignFallback('reasoning', 'opus');

  const r = await d.invoke('reasoning', { messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(r.text, 'from opus', 'a usage-limited primary is retried on the fallback');
});

test('dispatcher: does NOT fall back on non-usage-limit errors (bad output / generic)', async () => {
  const d = new LLMDispatcher();
  const opus = spyProvider('opus');
  d.register('sonnet', throwingProvider('sonnet', new Error('json parse: bad output')));
  d.register('opus', opus.provider);
  d.assign('reasoning', 'sonnet');
  d.assignFallback('reasoning', 'opus');

  await assert.rejects(() => d.invoke('reasoning', { messages: [] }), /bad output/);
  assert.equal(opus.calls(), 0, 'a non-usage-limit error must propagate, never touch the fallback');
});

test('dispatcher: a healthy primary never touches the fallback', async () => {
  const d = new LLMDispatcher();
  const opus = spyProvider('opus');
  d.register('sonnet', mockProvider('sonnet', 'from sonnet'));
  d.register('opus', opus.provider);
  d.assign('reasoning', 'sonnet');
  d.assignFallback('reasoning', 'opus');

  const r = await d.invoke('reasoning', { messages: [] });
  assert.equal(r.text, 'from sonnet');
  assert.equal(opus.calls(), 0, 'the fallback is dormant while the primary is healthy');
});

test('dispatcher: a fallback that also fails surfaces ITS error', async () => {
  const d = new LLMDispatcher();
  d.register('sonnet', throwingProvider('sonnet', new Error('subscription limit: sonnet down')));
  d.register('opus', throwingProvider('opus', new Error('subscription limit: opus down too')));
  d.assign('reasoning', 'sonnet');
  d.assignFallback('reasoning', 'opus');

  await assert.rejects(() => d.invoke('reasoning', { messages: [] }), /opus down too/);
});

test('dispatcher: assignFallback rejects an unregistered provider', () => {
  const d = new LLMDispatcher();
  assert.throws(() => d.assignFallback('reasoning', 'ghost'), /not registered/);
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
