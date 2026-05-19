import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LLMProvider, InvokeResult } from './types.ts';

test('types: LLMProvider interface accepts a valid impl', () => {
  const mock: LLMProvider = {
    name: 'mock',
    capabilities: new Set(['classify']),
    meta: { contextWindow: 4096, inputPricePerM: 0, outputPricePerM: 0 },
    invoke: async (): Promise<InvokeResult> => ({
      text: 'hi', usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 0, latencyMs: 1, provider: 'mock',
    }),
  };
  assert.equal(mock.name, 'mock');
});
