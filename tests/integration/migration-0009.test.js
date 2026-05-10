import assert from 'node:assert';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { writeConfig } from '../../src/runtime/config.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, '../../src/schema/migrations');

test.beforeEach(() => {
  const tmpHome = join(tmpdir(), `robin-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpHome, { recursive: true });
  process.env.ROBIN_HOME = tmpHome;
});

test('0009 adds from_v1 indexes + participates_in.meta + embed_backfill marker', async () => {
  await writeConfig({ embedder_profile: 'mxbai-1024' });
  const db = await connect({ engine: 'mem://' });
  try {
    await runMigrations(db, migrationsDir);

    // Check events table: embedded_at field and events_from_v1_hash index
    const [info] = await db.query('INFO FOR TABLE events').collect();
    const fields = info?.fields ?? {};
    const indexes = info?.indexes ?? {};
    assert.ok('embedded_at' in fields, 'events.embedded_at field present');
    assert.ok('events_from_v1_hash' in indexes, 'events_from_v1_hash index present');

    // Check entities table: entities_from_v1_hash index
    const [entInfo] = await db.query('INFO FOR TABLE entities').collect();
    const entIndexes = entInfo?.indexes ?? {};
    assert.ok('entities_from_v1_hash' in entIndexes, 'entities_from_v1_hash index present');

    // Check episodes table: episodes_from_v1_hash index
    const [epInfo] = await db.query('INFO FOR TABLE episodes').collect();
    const epIndexes = epInfo?.indexes ?? {};
    assert.ok('episodes_from_v1_hash' in epIndexes, 'episodes_from_v1_hash index present');

    // Check participates_in table: meta field added
    const [piInfo] = await db.query('INFO FOR TABLE participates_in').collect();
    const piFields = piInfo?.fields ?? {};
    assert.ok('meta' in piFields, 'participates_in.meta added');
  } finally {
    await close(db);
  }
});
