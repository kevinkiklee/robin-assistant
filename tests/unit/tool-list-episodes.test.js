import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createEpisode } from '../../src/graph/episodes.js';
import { createListEpisodesTool } from '../../src/mcp/tools/list-episodes.js';

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

test('list_episodes returns episodes with event counts', async () => {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  await createEpisode(db, { source: 'cli' });
  await createEpisode(db, { source: 'manual' });
  const tool = createListEpisodesTool({ db });
  const r = await tool.handler({});
  assert.ok(r.episodes.length >= 2);
  await close(db);
});

test('list_episodes filters by source', async () => {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  await createEpisode(db, { source: 'cli' });
  await createEpisode(db, { source: 'manual' });
  const tool = createListEpisodesTool({ db });
  const r = await tool.handler({ source: 'manual' });
  assert.ok(r.episodes.every((e) => e.source === 'manual'));
  await close(db);
});
