import assert from 'node:assert/strict';
import { mkdirSync as __mk } from 'node:fs';
import { tmpdir as __tmp } from 'node:os';
import { join as __join, resolve } from 'node:path';
import { test } from 'node:test';
import { readReinforcementConfig } from '../../cognition/intuition/reinforcement-config.js';
import { writeConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';

const home = __join(__tmp(), `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
__mk(home, { recursive: true });
process.env.ROBIN_HOME = home;
await writeConfig({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  return db;
}

test('readReinforcementConfig returns seeded values after migration', async () => {
  const db = await fresh();
  const c = await readReinforcementConfig(db);
  assert.equal(c.attribution_mode, 'off');
  assert.equal(c.similarity_threshold, 0.35);
  assert.equal(c.jaccard_min_overlap_tokens, 2);
  assert.equal(c.citation_date_window_days, 2);
  assert.equal(c.fallback_when_no_reply, true);
  assert.equal(c.fallback_when_zero_used, true);
  assert.equal(c.reply_lookup_window_ms, 600000);
  await close(db);
});

test('readReinforcementConfig merges partial overrides with defaults', async () => {
  const db = await fresh();
  await db
    .query('UPDATE runtime:`reinforcement.config` SET value.similarity_threshold = 0.5')
    .collect();
  const c = await readReinforcementConfig(db);
  assert.equal(c.similarity_threshold, 0.5);
  assert.equal(c.attribution_mode, 'off'); // unchanged
  await close(db);
});

test('readReinforcementConfig returns defaults when row is missing', async () => {
  const db = await fresh();
  await db.query('DELETE runtime:`reinforcement.config`').collect();
  const c = await readReinforcementConfig(db);
  assert.equal(c.attribution_mode, 'off');
  assert.equal(c.fallback_when_no_reply, true);
  await close(db);
});
