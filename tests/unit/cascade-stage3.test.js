import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stage3Disambig } from '../../src/graph/stage3-disambig.js';

function fakeHost(content) {
  return {
    name: 'fake',
    isAvailable: async () => true,
    invokeLLM: async () => ({ content, usage: { input_tokens: 0, output_tokens: 0 } }),
  };
}

test('stage3 picks an existing candidate when LLM names one', async () => {
  const host = fakeHost(JSON.stringify({ pick: 'entity-2' }));
  const result = await stage3Disambig(host, {
    mention: 'Alyse',
    type: 'person',
    candidates: [
      { id: 'entity-1', name: 'Alice', similarity: 0.85 },
      { id: 'entity-2', name: 'Allie', similarity: 0.82 },
    ],
  });
  assert.equal(result.action, 'resolve');
  assert.equal(result.entityId, 'entity-2');
});

test('stage3 returns none when LLM says null', async () => {
  const host = fakeHost(JSON.stringify({ pick: null }));
  const result = await stage3Disambig(host, {
    mention: 'Stranger',
    type: 'person',
    candidates: [{ id: 'entity-1', name: 'Alice', similarity: 0.81 }],
  });
  assert.equal(result.action, 'none');
});

test('stage3 returns none when LLM returns malformed output', async () => {
  const host = fakeHost('not json');
  const result = await stage3Disambig(host, {
    mention: 'X',
    type: 'person',
    candidates: [{ id: 'entity-1', name: 'A', similarity: 0.9 }],
  });
  assert.equal(result.action, 'none');
});

test('stage3 returns none when LLM picks an unknown id', async () => {
  const host = fakeHost(JSON.stringify({ pick: 'nope' }));
  const result = await stage3Disambig(host, {
    mention: 'X',
    type: 'person',
    candidates: [{ id: 'entity-1', name: 'A', similarity: 0.85 }],
  });
  assert.equal(result.action, 'none');
});

test('stage3 returns none when LLM call itself throws', async () => {
  const host = {
    name: 'fake',
    isAvailable: async () => true,
    invokeLLM: async () => {
      throw new Error('network');
    },
  };
  const result = await stage3Disambig(host, {
    mention: 'X',
    type: 'person',
    candidates: [{ id: 'entity-1', name: 'A', similarity: 0.85 }],
  });
  assert.equal(result.action, 'none');
});
