import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  chunkContent,
  dmDiscordAction,
  formatMessage,
  mdTablesToDiscord,
  notifyDiscordAction,
  postDigestAction,
} from './index.ts';

const ENV = {
  DISCORD_BOT_TOKEN: 'test-token',
  DISCORD_NOTIFY_CHANNEL_ID: 'C1',
  DISCORD_ALLOWED_USER_IDS: 'U1',
  DISCORD_ALLOWED_GUILD_ID: 'G1',
} as unknown as NodeJS.ProcessEnv;

interface Call {
  url: string;
  init: RequestInit;
}

function recorder(responses: Array<{ status?: number; body?: unknown }>) {
  const calls: Call[] = [];
  let i = 0;
  const fetchImpl = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const r = responses[Math.min(i++, responses.length - 1)] ?? {};
    const status = r.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => r.body ?? {},
      text: async () => JSON.stringify(r.body ?? {}),
    };
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

test('formatMessage mentions the operator, bolds the title, appends the link', () => {
  const out = formatMessage({ title: 'Brief', message: 'ready', link: 'https://x.test' }, ENV);
  assert.equal(out, '<@U1> **Brief**\nready\nhttps://x.test');
});

test('formatMessage omits the mention when mention:false', () => {
  assert.equal(formatMessage({ message: 'hi', mention: false }, ENV), 'hi');
});

test('formatMessage truncates to Discord 2000-char cap', () => {
  const out = formatMessage({ message: 'x'.repeat(4000), mention: false }, ENV);
  assert.equal(out.length, 2000);
  assert.ok(out.endsWith('…'));
});

test('notify posts to the configured channel with Bot auth', async () => {
  const { calls, fetchImpl } = recorder([{ body: { id: 'M1' } }]);
  const out = await notifyDiscordAction(
    { title: 'T', message: 'body' },
    { fetch: fetchImpl, env: ENV },
  );
  assert.deepEqual(out, { delivered: true, channelId: 'C1', messageId: 'M1' });
  assert.equal(calls[0].url, 'https://discord.com/api/v10/channels/C1/messages');
  assert.equal(calls[0].init.method, 'POST');
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers.authorization, 'Bot test-token');
  assert.equal(JSON.parse(String(calls[0].init.body)).content, '<@U1> **T**\nbody');
});

test('notify routes to an explicit channelId when given', async () => {
  const { calls, fetchImpl } = recorder([{ body: { id: 'M2' } }]);
  await notifyDiscordAction({ message: 'x', channelId: 'C9' }, { fetch: fetchImpl, env: ENV });
  assert.ok(calls[0].url.includes('/channels/C9/messages'));
});

test('notify reports instead of throwing when no channel is configured', async () => {
  const { fetchImpl } = recorder([]);
  const env = { ...ENV, DISCORD_NOTIFY_CHANNEL_ID: undefined } as unknown as NodeJS.ProcessEnv;
  const out = await notifyDiscordAction({ message: 'x' }, { fetch: fetchImpl, env });
  assert.equal(out.delivered, false);
  assert.match(String(out.reason), /DISCORD_NOTIFY_CHANNEL_ID/);
});

test('notify refuses a credential shape before it leaves the process', async () => {
  const { calls, fetchImpl } = recorder([{ body: { id: 'M3' } }]);
  const out = await notifyDiscordAction(
    { message: 'key is AKIAIOSFODNN7EXAMPLE' },
    { fetch: fetchImpl, env: ENV },
  );
  assert.equal(out.delivered, false);
  assert.equal(out.reason, 'discretion:secret:aws_access_key');
  assert.equal(calls.length, 0, 'must not reach the network');
});

test('notify surfaces an HTTP failure as a reason, not a throw', async () => {
  const { fetchImpl } = recorder([{ status: 403, body: { message: 'Missing Access' } }]);
  const out = await notifyDiscordAction({ message: 'x' }, { fetch: fetchImpl, env: ENV });
  assert.equal(out.delivered, false);
  assert.match(String(out.reason), /403/);
});

test('notify retries once on a 429 and honors retry_after', async () => {
  const { calls, fetchImpl } = recorder([
    { status: 429, body: { retry_after: 0.001 } },
    { body: { id: 'M4' } },
  ]);
  const out = await notifyDiscordAction({ message: 'x' }, { fetch: fetchImpl, env: ENV });
  assert.equal(out.delivered, true);
  assert.equal(calls.length, 2);
});

test('dm opens a DM channel, posts without a mention, and caches the channel', async () => {
  const env = { ...ENV, DISCORD_ALLOWED_USER_IDS: 'U-DM' } as unknown as NodeJS.ProcessEnv;
  const { calls, fetchImpl } = recorder([{ body: { id: 'D1' } }, { body: { id: 'M5' } }]);
  const first = await dmDiscordAction({ title: 'T', message: 'hi' }, { fetch: fetchImpl, env });
  assert.equal(first.delivered, true);
  assert.equal(calls[0].url, 'https://discord.com/api/v10/users/@me/channels');
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { recipient_id: 'U-DM' });
  assert.equal(calls[1].url, 'https://discord.com/api/v10/channels/D1/messages');
  assert.equal(JSON.parse(String(calls[1].init.body)).content, '**T**\nhi');

  const second = await dmDiscordAction({ message: 'again' }, { fetch: fetchImpl, env });
  assert.equal(second.delivered, true);
  assert.equal(calls.length, 3, 'cached DM channel — no second open');
});

test('silent:true sets SUPPRESS_NOTIFICATIONS (1<<12) alongside SUPPRESS_EMBEDS (1<<2)', async () => {
  const { calls, fetchImpl } = recorder([{ body: { id: 'M6' } }]);
  await notifyDiscordAction({ message: 'x', silent: true }, { fetch: fetchImpl, env: ENV });
  assert.equal(JSON.parse(String(calls[0].init.body)).flags, 4096 | 4);
});

test('embeds are suppressed by default — no link-preview cards', async () => {
  const { calls, fetchImpl } = recorder([{ body: { id: 'M7' } }]);
  await notifyDiscordAction({ message: 'see https://x.test' }, { fetch: fetchImpl, env: ENV });
  assert.equal(JSON.parse(String(calls[0].init.body)).flags, 4);
});

test('suppressEmbeds:false opts a message back into previews', async () => {
  const { calls, fetchImpl } = recorder([{ body: { id: 'M8' } }]);
  await notifyDiscordAction(
    { message: 'x', suppressEmbeds: false },
    { fetch: fetchImpl, env: ENV },
  );
  assert.equal('flags' in JSON.parse(String(calls[0].init.body)), false);
});

test('chunkContent keeps paragraphs whole and stays under the cap', () => {
  const para = (n: number) => `${`p${n}`} `.repeat(150).trim(); // ~600 chars each
  const text = [para(1), para(2), para(3), para(4), para(5)].join('\n\n');
  const chunks = chunkContent(text);
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(c.length <= 2000, `chunk ${c.length} over cap`);
  // No paragraph may be torn across a chunk boundary.
  for (let n = 1; n <= 5; n++) {
    assert.equal(chunks.filter((c) => c.includes(para(n))).length, 1, `para ${n} split`);
  }
});

test('chunkContent hard-splits a single paragraph longer than the cap', () => {
  const chunks = chunkContent('z'.repeat(5000));
  assert.equal(chunks.length, 3);
  for (const c of chunks) assert.ok(c.length <= 2000);
  assert.equal(chunks.join('').length, 5000);
});

test('chunkContent returns one chunk for short text and drops nothing', () => {
  assert.deepEqual(chunkContent('hello\n\nworld'), ['hello\n\nworld']);
});

test('digest posts the body straight into the channel, chunked and silent', async () => {
  const body = `${'a'.repeat(1500)}\n\n${'b'.repeat(1500)}`;
  const { calls, fetchImpl } = recorder([{ body: { id: 'P1' } }, { body: { id: 'P2' } }]);
  const out = await postDigestAction({ body }, { fetch: fetchImpl, env: ENV });

  assert.equal(out.delivered, true);
  assert.equal(out.parts, 2);
  assert.equal(calls.length, 2, 'no header message, no thread — just the body');
  for (const c of calls) {
    assert.equal(c.url, 'https://discord.com/api/v10/channels/C1/messages');
    assert.equal(JSON.parse(String(c.init.body)).flags, 4096 | 4, 'silent + no previews');
  }
  assert.ok(JSON.parse(String(calls[0].init.body)).content.startsWith('a'));
  assert.ok(JSON.parse(String(calls[1].init.body)).content.startsWith('b'));
});

test('digest never opens a thread', async () => {
  const { calls, fetchImpl } = recorder([{ body: { id: 'P1' } }]);
  await postDigestAction({ body: 'short' }, { fetch: fetchImpl, env: ENV });
  assert.equal(calls.filter((c) => c.url.includes('/threads')).length, 0);
});

test('digest prepends an optional title to the first chunk, not a separate message', async () => {
  const { calls, fetchImpl } = recorder([{ body: { id: 'P1' } }]);
  await postDigestAction({ title: 'Report', body: 'body text' }, { fetch: fetchImpl, env: ENV });
  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(String(calls[0].init.body)).content, '**Report**\n\nbody text');
});

test('digest routes to an explicit channelId', async () => {
  const { calls, fetchImpl } = recorder([{ body: { id: 'P1' } }]);
  await postDigestAction({ body: 'x', channelId: 'C-BRIEF' }, { fetch: fetchImpl, env: ENV });
  assert.equal(calls[0].url, 'https://discord.com/api/v10/channels/C-BRIEF/messages');
});

test('digest refuses a credential shape anywhere in the body', async () => {
  const { calls, fetchImpl } = recorder([{ body: { id: 'HEAD' } }]);
  const out = await postDigestAction(
    { body: 'line one\n\nAKIAIOSFODNN7EXAMPLE\n\nline three' },
    { fetch: fetchImpl, env: ENV },
  );
  assert.equal(out.delivered, false);
  assert.equal(out.reason, 'discretion:secret:aws_access_key');
  assert.equal(calls.length, 0);
});

// ── markdown tables → Discord ───────────────────────────────────────────────
test('mdTablesToDiscord renders a narrow, link-free table as an aligned code block', () => {
  const out = mdTablesToDiscord(
    [
      '| Account | Balance | As of |',
      '| --- | ---: | ---: |',
      '| Card A | $1,234.56 | 01-15 |',
      '| Brokerage | $100.00 | 01-15 |',
    ].join('\n'),
  );
  assert.ok(out.startsWith('```') && out.endsWith('```'), 'wrapped in a code fence');
  assert.ok(!out.includes('|'), 'pipes are gone');
  const rows = out.split('\n').filter((l) => l.includes('$'));
  // Right-aligned numeric columns line up: same index for both '$' signs.
  assert.equal(
    rows[0].indexOf('$1,234.56') + '$1,234.56'.length,
    rows[1].indexOf('$100.00') + '$100.00'.length,
  );
});

test('mdTablesToDiscord renders a table containing links as bullets, links intact', () => {
  const out = mdTablesToDiscord(
    [
      '| Subject | From |',
      '| --- | --- |',
      '| [Your receipt](https://mail.test/1) | Vercel |',
    ].join('\n'),
  );
  assert.ok(!out.includes('```'), 'a code block would swallow the link');
  assert.ok(!out.includes('|'));
  assert.equal(out, '**Subject · From**\n- [Your receipt](https://mail.test/1) · Vercel');
});

test('mdTablesToDiscord falls back to bullets for a wide table', () => {
  const wide = 'x'.repeat(40);
  const out = mdTablesToDiscord([`| A | B |`, '| --- | --- |', `| ${wide} | ${wide} |`].join('\n'));
  assert.ok(!out.includes('```'), 'too wide for a phone-friendly code block');
  assert.ok(out.startsWith('**A · B**'));
});

test('mdTablesToDiscord leaves ordinary prose and existing code fences alone', () => {
  const text = ['Some prose.', '', '```', '| not | a | table |', '```', '', '- a bullet'].join(
    '\n',
  );
  assert.equal(mdTablesToDiscord(text), text);
});

test('mdTablesToDiscord converts every table in a document', () => {
  const t = (n: string) => [`| ${n} |`, '| --- |', `| ${n}-row |`].join('\n');
  const out = mdTablesToDiscord(`${t('one')}\n\nmiddle prose\n\n${t('two')}`);
  assert.ok(!out.includes('|'));
  assert.ok(out.includes('middle prose'));
});

test('digest converts tables before chunking', async () => {
  const { calls, fetchImpl } = recorder([{ body: { id: 'P1' } }]);
  await postDigestAction(
    { body: ['| A | B |', '| --- | --- |', '| 1 | 2 |'].join('\n') },
    { fetch: fetchImpl, env: ENV },
  );
  assert.ok(!JSON.parse(String(calls[0].init.body)).content.includes('|'));
});
