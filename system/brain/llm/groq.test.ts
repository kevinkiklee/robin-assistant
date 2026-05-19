import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startMockServer } from './_test-server.ts';
import { GroqProvider } from './groq.ts';

test('groq: invoke parses response', async () => {
  const { url, server } = await startMockServer([
    {
      method: 'POST',
      path: '/chat/completions',
      body: { choices: [{ message: { content: 'hello' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
    },
  ]);
  const p = new GroqProvider({ baseUrl: url, apiKey: 'test' });
  const r = await p.invoke({ messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(r.text, 'hello');
  assert.equal(r.usage.inputTokens, 10);
  server.close();
});
