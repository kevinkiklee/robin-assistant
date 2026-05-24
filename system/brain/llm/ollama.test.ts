import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startMockServer } from './_test-server.ts';
import { OllamaProvider } from './ollama.ts';

test('ollama: invoke returns text + usage from mock /api/chat', async () => {
  const { url, server } = await startMockServer([
    {
      method: 'POST',
      path: '/api/chat',
      body: { message: { content: 'hello world' }, prompt_eval_count: 7, eval_count: 3 },
    },
  ]);
  const p = new OllamaProvider({ baseUrl: url, chatModel: 'm' });
  const r = await p.invoke({ messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(r.text, 'hello world');
  assert.equal(r.usage.inputTokens, 7);
  assert.equal(r.usage.outputTokens, 3);
  assert.equal(r.provider, 'ollama');
  server.close();
});

test('ollama: embed returns 1d arrays per input', async () => {
  const { url, server } = await startMockServer([
    { method: 'POST', path: '/api/embeddings', body: { embedding: [0.1, 0.2, 0.3] } },
  ]);
  const p = new OllamaProvider({ baseUrl: url, chatModel: 'm', embedModel: 'e' });
  const r = await p.embed(['one']);
  assert.deepEqual(r, [[0.1, 0.2, 0.3]]);
  server.close();
});

test('ollama: invoke sends num_ctx + think when configured', async () => {
  const { url, server, received } = await startMockServer([
    { method: 'POST', path: '/api/chat', body: { message: { content: 'x' }, eval_count: 1 } },
  ]);
  const p = new OllamaProvider({ baseUrl: url, chatModel: 'm', numCtx: 32768, think: false });
  await p.invoke({ messages: [{ role: 'user', content: 'hi' }] });
  const sent = received[0].body as { options: { num_ctx?: number }; think?: boolean };
  assert.equal(sent.options.num_ctx, 32768);
  assert.equal(sent.think, false);
  server.close();
});

test('ollama: omits num_ctx + think when not configured', async () => {
  const { url, server, received } = await startMockServer([
    { method: 'POST', path: '/api/chat', body: { message: { content: 'x' }, eval_count: 1 } },
  ]);
  const p = new OllamaProvider({ baseUrl: url, chatModel: 'm' });
  await p.invoke({ messages: [{ role: 'user', content: 'hi' }] });
  const sent = received[0].body as { options: Record<string, unknown>; think?: boolean };
  assert.equal('num_ctx' in sent.options, false);
  assert.equal('think' in sent, false);
  server.close();
});

test('ollama: invoke throws on non-OK status', async () => {
  const { url, server } = await startMockServer([
    { method: 'POST', path: '/api/chat', status: 500, body: { error: 'broken' } },
  ]);
  const p = new OllamaProvider({ baseUrl: url, chatModel: 'm' });
  await assert.rejects(
    p.invoke({ messages: [{ role: 'user', content: 'hi' }] }),
    /ollama chat 500/,
  );
  server.close();
});
