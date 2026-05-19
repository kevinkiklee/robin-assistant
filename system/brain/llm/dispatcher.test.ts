import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LLMDispatcher } from './dispatcher.ts';
import type { LLMProvider } from './types.ts';

function mockProvider(name: string, text: string): LLMProvider {
  return {
    name,
    capabilities: new Set(['classify']),
    meta: { contextWindow: 4096, inputPricePerM: 0, outputPricePerM: 0 },
    invoke: async () => ({ text, usage: { inputTokens: 0, outputTokens: 0 }, costUsd: 0, latencyMs: 0, provider: name }),
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
