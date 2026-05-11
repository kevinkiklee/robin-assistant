import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { validateBotToken } from '../../io/integrations/_auth/discord-bot.js';

test('validateBotToken hits /users/@me with Bot prefix', async () => {
  const calls = [];
  const fakeFetch = mock.fn(async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, json: async () => ({ id: 'bot1', username: 'robot' }) };
  });
  const r = await validateBotToken({ token: 't', fetchFn: fakeFetch });
  assert.equal(r.username, 'robot');
  assert.equal(calls[0].opts.headers.Authorization, 'Bot t');
});

test('validateBotToken throws on invalid token', async () => {
  const fakeFetch = mock.fn(async () => ({ ok: false, status: 401 }));
  await assert.rejects(() => validateBotToken({ token: 'x', fetchFn: fakeFetch }));
});
