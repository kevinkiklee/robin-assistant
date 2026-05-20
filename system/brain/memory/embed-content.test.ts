import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LLMDispatcher } from '../llm/dispatcher.ts';
import type { LLMProvider } from '../llm/types.ts';
import { EMBED_MAX_CHARS, embedBody, prepareForEmbed } from './embed-content.ts';

describe('embed-content', () => {
  it('passes through bodies under the cap unchanged', () => {
    const body = 'short body';
    assert.equal(prepareForEmbed(body), body);
  });

  it('truncates bodies longer than EMBED_MAX_CHARS to exactly that length', () => {
    const body = 'x'.repeat(EMBED_MAX_CHARS + 50_000);
    const out = prepareForEmbed(body);
    assert.equal(out.length, EMBED_MAX_CHARS);
    assert.equal(out, body.slice(0, EMBED_MAX_CHARS));
  });

  it('embedBody sends the truncated body to the dispatcher', async () => {
    let received = '';
    const captureProvider: LLMProvider = {
      name: 'capture',
      capabilities: new Set(['embed']),
      meta: { contextWindow: 8192, inputPricePerM: 0, outputPricePerM: 0 },
      embed: async (text) => {
        received = Array.isArray(text) ? text[0] : text;
        return [new Array(4096).fill(0)];
      },
      invoke: async () => {
        throw new Error('not used');
      },
    };
    const d = new LLMDispatcher();
    d.register('cap', captureProvider);
    d.assign('embed', 'cap');

    const body = 'a'.repeat(EMBED_MAX_CHARS + 1000);
    const vec = await embedBody(d, body);
    assert.equal(vec.length, 4096);
    assert.equal(received.length, EMBED_MAX_CHARS);
  });

  it('embedBody surfaces an error on empty embedding', async () => {
    const emptyProvider: LLMProvider = {
      name: 'empty',
      capabilities: new Set(['embed']),
      meta: { contextWindow: 8192, inputPricePerM: 0, outputPricePerM: 0 },
      embed: async () => [[]],
      invoke: async () => {
        throw new Error('not used');
      },
    };
    const d = new LLMDispatcher();
    d.register('e', emptyProvider);
    d.assign('embed', 'e');
    await assert.rejects(() => embedBody(d, 'anything'), /empty embedding/);
  });
});
