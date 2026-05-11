import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { writeConfig as __robinWriteConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createStubEmbedder } from '../../data/embed/embedder.js';
import { createCapture } from '../../io/integrations/_framework/capture.js';
import {
  buildEventFromMessage,
  classifyMessage,
  isAllowed,
} from '../../io/integrations/discord/dispatcher.js';
import { makeMessage } from '../fixtures/discord-events.js';

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
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  return db;
}

test('allowlist drops non-allowlisted messages from capture path', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 1024 });
  const capture = createCapture({
    db,
    embedder: e,
    source: 'discord',
    embed: false,
    mode: 'insert-or-skip',
  });
  const allowlist = { user_ids: ['u1'], guild_ids: ['g1'], dm_user_ids: ['u1'] };
  const botId = 'bot1';

  const messages = [
    makeMessage({ id: 'm1', author_id: 'u1', dm: true }), // allowed DM
    makeMessage({ id: 'm2', author_id: 'rando', dm: true }), // blocked DM
    makeMessage({ id: 'm3', author_id: 'u1', guild_id: 'g1', mentions_bot: true }), // allowed mention
    makeMessage({ id: 'm4', author_id: 'rando', guild_id: 'g1' }), // blocked (wrong user)
    makeMessage({ id: 'm5', author_id: 'u1', guild_id: 'g1' }), // dropped (allowed but classified 'other')
  ];

  for (const msg of messages) {
    if (!isAllowed({ allowlist, message: msg })) continue;
    const kind = classifyMessage(msg, botId);
    if (kind === 'other') continue;
    await capture([buildEventFromMessage(msg, kind)]);
  }

  const [rows] = await db
    .query(
      surql`SELECT meta.external_id AS external_id FROM events WHERE source = 'discord' ORDER BY external_id`,
    )
    .collect();
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.external_id).sort(), ['m1', 'm3']);
  await close(db);
});
