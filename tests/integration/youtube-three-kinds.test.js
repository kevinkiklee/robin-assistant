import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { mock, test } from 'node:test';
import { surql } from 'surrealdb';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createStubEmbedder } from '../../src/embed/embedder.js';
import { _resetCache } from '../../src/integrations/_auth/token-cache.js';
import { createCapture } from '../../src/integrations/_framework/capture.js';
import { sync } from '../../src/integrations/youtube/sync.js';

import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin } from 'node:path';
import { writeConfig as __robinWriteConfig } from '../../src/runtime/config.js';

// __robin_test_home_setup__
const __robinTestHome = __robinJoin(
  __robinTmpdir(),
  `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
);
__robinMkdirSync(__robinTestHome, { recursive: true });
process.env.ROBIN_HOME = __robinTestHome;
await __robinWriteConfig({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return db;
}

test('youtube sync produces three event kinds in events table', async () => {
  _resetCache('google');
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const capture = createCapture({
    db,
    embedder: e,
    source: 'youtube',
    embed: true,
    mode: 'insert-or-skip',
  });
  const fetchFn = mock.fn(async (url) => {
    if (url.includes('/token')) {
      return { ok: true, json: async () => ({ access_token: 'a', expires_in: 3600 }) };
    }
    if (url.includes('/subscriptions')) {
      return {
        ok: true,
        json: async () => ({
          items: [
            {
              id: 's1',
              snippet: {
                resourceId: { channelId: 'c1' },
                title: 'A',
                publishedAt: '2026-01-01T00:00:00Z',
              },
            },
          ],
        }),
      };
    }
    if (url.includes('/playlists')) {
      return {
        ok: true,
        json: async () => ({
          items: [
            {
              id: 'p1',
              snippet: { title: 'P', publishedAt: '2026-01-01T00:00:00Z' },
              contentDetails: { itemCount: 5 },
            },
          ],
        }),
      };
    }
    if (url.includes('/videos')) {
      return {
        ok: true,
        json: async () => ({
          items: [
            {
              id: 'v1',
              snippet: {
                title: 'V',
                channelTitle: 'A',
                channelId: 'c1',
                publishedAt: '2026-01-01T00:00:00Z',
              },
            },
          ],
        }),
      };
    }
    throw new Error(`unexpected: ${url}`);
  });
  const r = await sync({
    secrets: {
      GOOGLE_OAUTH_REFRESH_TOKEN: 'r',
      GOOGLE_OAUTH_CLIENT_ID: 'c',
      GOOGLE_OAUTH_CLIENT_SECRET: 's',
    },
    log: () => {},
    cursor: null,
    capture,
    fetchFn,
  });
  assert.equal(r.count, 3);

  const [rows] = await db
    .query(
      surql`SELECT external_id, meta FROM events WHERE source = 'youtube' ORDER BY external_id ASC`,
    )
    .collect();
  assert.equal(rows.length, 3);
  const ids = rows.map((r) => r.external_id);
  assert.ok(ids.includes('liked:v1'));
  assert.ok(ids.includes('playlist:p1'));
  assert.ok(ids.includes('sub:c1'));
  await close(db);
});
