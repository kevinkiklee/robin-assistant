import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import { _resetCache } from '../../io/integrations/_auth/token-cache.js';

let tmpHome;
test.beforeEach(() => {
  tmpHome = join(tmpdir(), `robin-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpHome, { recursive: true });
  process.env.ROBIN_HOME = tmpHome;
  _resetCache('google');
});
test.afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

async function seedSecrets() {
  const { saveSecret } = await import(`../../src/secrets/dotenv-io.js?cb=${Date.now()}`);
  saveSecret('GA_PROPERTIES', '12345');
}

test('sync captures one event per day per property', async () => {
  await seedSecrets();
  const { sync } = await import(`../../src/integrations/ga/sync.js?cb=${Date.now()}`);
  const fetchFn = mock.fn(async (url) => {
    if (url.includes('/token')) {
      return { ok: true, json: async () => ({ access_token: 'a', expires_in: 3600 }) };
    }
    if (url.includes(':runReport')) {
      return {
        ok: true,
        json: async () => ({
          rows: [
            {
              dimensionValues: [{ value: '20260509' }],
              metricValues: [
                { value: '100' },
                { value: '50' },
                { value: '120' },
                { value: '500' },
                { value: '0.4' },
                { value: '120' },
              ],
            },
            {
              dimensionValues: [{ value: '20260510' }],
              metricValues: [
                { value: '200' },
                { value: '80' },
                { value: '220' },
                { value: '700' },
                { value: '0.3' },
                { value: '150' },
              ],
            },
          ],
        }),
      };
    }
    throw new Error(`unexpected: ${url}`);
  });
  const captured = [];
  const r = await sync({
    secrets: {
      GOOGLE_OAUTH_REFRESH_TOKEN: 'r',
      GOOGLE_OAUTH_CLIENT_ID: 'c',
      GOOGLE_OAUTH_CLIENT_SECRET: 's',
    },
    log: () => {},
    cursor: null,
    capture: async (rows) => {
      captured.push(...rows);
      return {};
    },
    fetchFn,
  });
  assert.equal(r.count, 2);
  assert.equal(captured[0].external_id, 'ga:12345:2026-05-09');
  assert.equal(captured[1].external_id, 'ga:12345:2026-05-10');
  assert.equal(captured[0].source, 'ga');
  assert.equal(captured[0].meta.users, 100);
  assert.equal(captured[0].meta.sessions, 120);
});

test('sync iterates multiple properties and tags external_id per property', async () => {
  await seedSecrets();
  const { saveSecret } = await import(`../../src/secrets/dotenv-io.js?cb=${Date.now()}`);
  saveSecret('GA_PROPERTIES', '12345, 67890');
  const { sync } = await import(`../../src/integrations/ga/sync.js?cb=${Date.now()}`);
  const fetchFn = mock.fn(async (url) => {
    if (url.includes('/token')) {
      return { ok: true, json: async () => ({ access_token: 'a', expires_in: 3600 }) };
    }
    if (url.includes(':runReport')) {
      return {
        ok: true,
        json: async () => ({
          rows: [
            {
              dimensionValues: [{ value: '20260509' }],
              metricValues: [
                { value: '1' },
                { value: '1' },
                { value: '1' },
                { value: '1' },
                { value: '0' },
                { value: '0' },
              ],
            },
          ],
        }),
      };
    }
    throw new Error(`unexpected: ${url}`);
  });
  const captured = [];
  await sync({
    secrets: {
      GOOGLE_OAUTH_REFRESH_TOKEN: 'r',
      GOOGLE_OAUTH_CLIENT_ID: 'c',
      GOOGLE_OAUTH_CLIENT_SECRET: 's',
    },
    log: () => {},
    cursor: null,
    capture: async (rows) => {
      captured.push(...rows);
      return {};
    },
    fetchFn,
  });
  const ids = captured.map((e) => e.external_id).sort();
  assert.deepEqual(ids, ['ga:12345:2026-05-09', 'ga:67890:2026-05-09']);
});

test('403 PERMISSION_DENIED logs re-auth instruction and re-throws', async () => {
  await seedSecrets();
  const { sync } = await import(`../../src/integrations/ga/sync.js?cb=${Date.now()}`);
  const messages = [];
  const fetchFn = mock.fn(async (url) => {
    if (url.includes('/token')) {
      return { ok: true, json: async () => ({ access_token: 'a', expires_in: 3600 }) };
    }
    return {
      ok: false,
      status: 403,
      text: async () => '{"error":{"status":"PERMISSION_DENIED","message":"insufficient scope"}}',
      json: async () => null,
    };
  });
  await assert.rejects(() =>
    sync({
      secrets: {
        GOOGLE_OAUTH_REFRESH_TOKEN: 'r',
        GOOGLE_OAUTH_CLIENT_ID: 'c',
        GOOGLE_OAUTH_CLIENT_SECRET: 's',
      },
      log: (m) => messages.push(m),
      cursor: null,
      capture: async () => ({}),
      fetchFn,
    }),
  );
  assert.ok(messages.some((m) => /robin auth google --code/.test(m)));
});

test('403 ACCESS_TOKEN_SCOPE_INSUFFICIENT also triggers scope-error path', async () => {
  await seedSecrets();
  const { sync } = await import(`../../src/integrations/ga/sync.js?cb=${Date.now()}`);
  const messages = [];
  const fetchFn = mock.fn(async (url) => {
    if (url.includes('/token')) {
      return { ok: true, json: async () => ({ access_token: 'a', expires_in: 3600 }) };
    }
    return {
      ok: false,
      status: 403,
      text: async () =>
        '{"error":{"status":"PERMISSION_DENIED","details":[{"reason":"ACCESS_TOKEN_SCOPE_INSUFFICIENT"}]}}',
      json: async () => null,
    };
  });
  await assert.rejects(() =>
    sync({
      secrets: {
        GOOGLE_OAUTH_REFRESH_TOKEN: 'r',
        GOOGLE_OAUTH_CLIENT_ID: 'c',
        GOOGLE_OAUTH_CLIENT_SECRET: 's',
      },
      log: (m) => messages.push(m),
      cursor: null,
      capture: async () => ({}),
      fetchFn,
    }),
  );
  assert.ok(messages.some((m) => /analytics\.readonly/.test(m)));
});

test('missing GA_PROPERTIES env throws clear error', async () => {
  // Don't seed GA_PROPERTIES.
  const { sync } = await import(`../../src/integrations/ga/sync.js?cb=${Date.now()}`);
  await assert.rejects(
    () =>
      sync({
        secrets: {
          GOOGLE_OAUTH_REFRESH_TOKEN: 'r',
          GOOGLE_OAUTH_CLIENT_ID: 'c',
          GOOGLE_OAUTH_CLIENT_SECRET: 's',
        },
        log: () => {},
        cursor: null,
        capture: async () => ({}),
        fetchFn: async () => ({ ok: true, json: async () => ({}) }),
      }),
    /GA_PROPERTIES/,
  );
});
