import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LLMDispatcher } from '../llm/dispatcher.ts';
import type { LLMProvider } from '../llm/types.ts';
import { EMBED_MAX_CHARS, embedBodies, embedBody, prepareForEmbed } from './embed-content.ts';

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

  it('embedBodies sends ONE batched call with all (truncated) bodies, in order', async () => {
    let receivedArg: string | string[] = '';
    const batchProvider: LLMProvider = {
      name: 'batch',
      capabilities: new Set(['embed']),
      meta: { contextWindow: 8192, inputPricePerM: 0, outputPricePerM: 0 },
      embed: async (text) => {
        receivedArg = text;
        const arr = Array.isArray(text) ? text : [text];
        // one distinct vector per input, in order
        return arr.map((_, i) => new Array(3072).fill(i + 1));
      },
      invoke: async () => {
        throw new Error('not used');
      },
    };
    const d = new LLMDispatcher();
    d.register('b', batchProvider);
    d.assign('embed', 'b');

    const long = 'a'.repeat(EMBED_MAX_CHARS + 100);
    const vecs = await embedBodies(d, ['one', long, 'three']);
    assert.ok(
      Array.isArray(receivedArg),
      'dispatcher.embed received a single array (one batched call)',
    );
    assert.equal((receivedArg as string[]).length, 3);
    assert.equal((receivedArg as string[])[1].length, EMBED_MAX_CHARS, 'long body truncated');
    assert.equal(vecs.length, 3);
    assert.equal(vecs[0][0], 1); // order preserved
    assert.equal(vecs[2][0], 3);
  });

  it('embedBodies returns [] for empty input (no call)', async () => {
    const d = new LLMDispatcher();
    let called = false;
    d.register('x', {
      name: 'x',
      capabilities: new Set(['embed']),
      meta: { contextWindow: 8192, inputPricePerM: 0, outputPricePerM: 0 },
      embed: async () => {
        called = true;
        return [];
      },
      invoke: async () => {
        throw new Error('not used');
      },
    });
    d.assign('embed', 'x');
    const vecs = await embedBodies(d, []);
    assert.deepEqual(vecs, []);
    assert.equal(called, false);
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
