import assert from 'node:assert/strict';
import { test } from 'node:test';
import { notifyDiscordAction, postDigestAction } from './index.ts';

const ENV = {
  DISCORD_BOT_TOKEN: 'test-token',
  DISCORD_NOTIFY_CHANNEL_ID: 'C1',
  DISCORD_BRIEF_CHANNEL_ID: 'C2',
  DISCORD_ALLOWED_USER_IDS: 'U1,U2',
} as NodeJS.ProcessEnv;

function capture() {
  const bodies: Record<string, unknown>[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ id: 'M' }), { status: 200 });
  }) as unknown as typeof fetch;
  return { bodies, fetchImpl };
}

// Brief and alert text can quote third-party strings (email subjects). Discord must
// resolve no mention from that text — only the operator's own ping.
test('discord posts allow mentions of the operator only — never @everyone or roles', async () => {
  const { bodies, fetchImpl } = capture();
  await notifyDiscordAction(
    { title: 'Inbox', message: 'Subject: @everyone <@&123> free stuff' },
    { fetch: fetchImpl, env: ENV },
  );
  await postDigestAction({ body: 'digest @here' }, { fetch: fetchImpl, env: ENV });
  assert.ok(bodies.length >= 2);
  for (const b of bodies) {
    assert.deepEqual(b.allowed_mentions, { parse: [], users: ['U1'] });
  }
});
