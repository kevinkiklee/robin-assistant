import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { recordEvent } from '../../io/capture/record-event.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createStubEmbedder } from '../../data/embed/embedder.js';
import { writeConfig as __robinWriteConfig } from '../../config/paths.js';

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

test("recordEvent accepts source='conversation'", async () => {
  const db = await fresh();
  try {
    const embedder = createStubEmbedder();
    const { id } = await recordEvent(db, embedder, {
      source: 'conversation',
      content: 'USER: hi\n\nASSISTANT: hello',
    });
    const [rows] = await db.query(surql`SELECT source FROM ${id}`).collect();
    assert.equal(rows[0].source, 'conversation');
  } finally {
    await close(db);
  }
});
