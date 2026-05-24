import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LLMDispatcher } from '../llm/dispatcher.ts';
import type { LLMProvider } from '../llm/types.ts';
import { EMBED_MAX_CHARS, embedBody, prepareForEmbed } from './embed-content.ts';

describe('embed-content', () => {
  it('caps input at 8000 chars (~2048-token cloud embedder limit)', () => {
    assert.equal(EMBED_MAX_CHARS, 8_000);
  });

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
        return [new Array(3072).fill(0)];
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
    assert.equal(vec.length, 3072);
    assert.equal(received.length, EMBED_MAX_CHARS);
  });

  it('prepareForEmbed decodes a Buffer body to its UTF-8 string', () => {
    // Rows stored with BLOB affinity (historical ingest bound a Buffer) read back as Buffers.
    // The original content here is a run of box-drawing chars — content_ids 13466/13467.
    const original = '━'.repeat(1000);
    const buf = Buffer.from(original, 'utf8');
    const out = prepareForEmbed(buf);
    assert.equal(typeof out, 'string');
    assert.equal(out, original);
  });

  it('prepareForEmbed truncates a long Buffer body after decoding', () => {
    const original = '━'.repeat(EMBED_MAX_CHARS + 5000);
    const out = prepareForEmbed(Buffer.from(original, 'utf8'));
    assert.equal(out.length, EMBED_MAX_CHARS);
    assert.equal(out, original.slice(0, EMBED_MAX_CHARS));
  });

  it('embedBody passes a string (never a Buffer) to the dispatcher', async () => {
    let received: unknown = null;
    const captureProvider: LLMProvider = {
      name: 'capture',
      capabilities: new Set(['embed']),
      meta: { contextWindow: 8192, inputPricePerM: 0, outputPricePerM: 0 },
      embed: async (text) => {
        received = Array.isArray(text) ? text[0] : text;
        return [new Array(3072).fill(0)];
      },
      invoke: async () => {
        throw new Error('not used');
      },
    };
    const d = new LLMDispatcher();
    d.register('cap', captureProvider);
    d.assign('embed', 'cap');

    const buf = Buffer.from('━'.repeat(50), 'utf8');
    await embedBody(d, buf);
    assert.equal(typeof received, 'string');
    assert.equal(Buffer.isBuffer(received), false);
    assert.equal(received, '━'.repeat(50));
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
