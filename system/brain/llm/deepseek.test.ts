import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startMockServer } from './_test-server.ts';
import { DeepSeekProvider } from './deepseek.ts';

test('deepseek: invoke parses response + computes cost', async () => {
  const { url, server } = await startMockServer([
    {
      method: 'POST',
      path: '/chat/completions',
      body: {
        choices: [{ message: { content: 'hello' } }],
        usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 },
      },
    },
  ]);
  const p = new DeepSeekProvider({ baseUrl: url, apiKey: 'test', model: 'm' });
  const r = await p.invoke({ messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(r.text, 'hello');
  assert.ok(Math.abs(r.costUsd - 0.42) < 0.01, `cost was ${r.costUsd}`);
  server.close();
});

test('deepseek: throws on non-OK response', async () => {
  const { url, server } = await startMockServer([
    { method: 'POST', path: '/chat/completions', status: 401, body: { error: 'bad key' } },
  ]);
  const p = new DeepSeekProvider({ baseUrl: url, apiKey: 'bad' });
  await assert.rejects(p.invoke({ messages: [{ role: 'user', content: 'hi' }] }), /deepseek 401/);
  server.close();
});
