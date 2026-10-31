import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeGoogleGet } from './google-api.ts';
import type { IntegrationContext } from './types.ts';

function fakeCtx(fetchFn: typeof fetch): IntegrationContext {
  return { fetch: fetchFn } as unknown as IntegrationContext;
}

test('makeGoogleGet: prepends baseUrl, sends Bearer token, parses JSON', async () => {
  let seenUrl = '';
  let seenAuth = '';
  const ctx = fakeCtx(async (url, init) => {
    seenUrl = String(url);
    seenAuth = String((init?.headers as Record<string, string>).Authorization);
    return new Response(JSON.stringify({ ok: true, n: 42 }), { status: 200 });
  });
  const get = makeGoogleGet('gmail', 'https://gmail.googleapis.com/v1');
  const out = await get<{ ok: boolean; n: number }>(ctx, '/messages?q=x', 'tok-abc');
  assert.equal(seenUrl, 'https://gmail.googleapis.com/v1/messages?q=x');
  assert.equal(seenAuth, 'Bearer tok-abc');
  assert.deepEqual(out, { ok: true, n: 42 });
});

test('makeGoogleGet: throws with serviceName, path, status, and body on non-2xx', async () => {
  const ctx = fakeCtx(async () => new Response('rate limit exceeded', { status: 429 }));
  const get = makeGoogleGet('calendar', 'https://www.googleapis.com/calendar/v3');
  await assert.rejects(get(ctx, '/calendars/primary/events', 'tok'), (err: Error) => {
    assert.match(err.message, /^calendar /);
    assert.match(err.message, /\/calendars\/primary\/events/);
    assert.match(err.message, /429/);
    assert.match(err.message, /rate limit exceeded/);
    return true;
  });
});

test('makeGoogleGet: typed response — caller type parameter is preserved', async () => {
  const ctx = fakeCtx(
    async () =>
      new Response(JSON.stringify({ items: [{ id: 'a' }, { id: 'b' }] }), { status: 200 }),
  );
  const get = makeGoogleGet('drive', 'https://www.googleapis.com/drive/v3');
  const out = await get<{ items: Array<{ id: string }> }>(ctx, '/files', 'tok');
  assert.equal(out.items.length, 2);
  assert.equal(out.items[0].id, 'a');
});
