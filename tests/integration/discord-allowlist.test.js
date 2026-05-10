import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createStubEmbedder } from '../../src/embed/embedder.js';
import { createCapture } from '../../src/integrations/_framework/capture.js';
import {
  buildEventFromMessage,
  classifyMessage,
  isAllowed,
} from '../../src/integrations/discord/dispatcher.js';
import { makeMessage } from '../fixtures/discord-events.js';

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return db;
}

test('allowlist drops non-allowlisted messages from capture path', async () => {
  const db = await fresh();
  const e = createStubEmbedder({ dimension: 384 });
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
    .query(surql`SELECT external_id FROM events WHERE source = 'discord' ORDER BY external_id`)
    .collect();
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.external_id).sort(), ['m1', 'm3']);
  await close(db);
});
