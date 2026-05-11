import assert from 'node:assert';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { runMigration } from '../../src/migrate-v1/index.js';
import { paths } from '../../src/runtime/data-store.js';

// NOTE: We do NOT seed v1 via rocksdb and then re-open it in the same process.
// The rocksdb engine does not release its file lock synchronously on close, so
// a same-process seed → close → openV1(same path) pattern hangs reliably.
//
// Workaround: seed v1 data using mem:// (same SurrealQL surface, different engine)
// and pass the live handle directly via the `v1Handle` option added to runMigration.
// This avoids any file-lock issue while exercising the full migration logic.

function setupTestHome() {
  const home = mkdtempSync(join(tmpdir(), 'robin-orch-'));
  process.env.ROBIN_HOME = home;
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'config.json'), JSON.stringify({ embedder_profile: 'mxbai-1024' }));
  return home;
}

/** Seed a mem:// connection with the v1 data shape and return the open handle. */
async function openSeededV1() {
  const db = await connect({ engine: 'mem://' });
  // v1 uses namespace=robin, database=main — same as connect() default
  await db.query('DEFINE TABLE entity SCHEMALESS;').collect();
  await db.query('DEFINE TABLE episode SCHEMALESS;').collect();
  await db.query('DEFINE TABLE capture SCHEMALESS;').collect();
  await db
    .query('DEFINE TABLE derived_from TYPE RELATION FROM episode TO capture SCHEMALESS;')
    .collect();

  await db
    .query(surql`CREATE entity:e1 SET name = 'Eric', kind = 'person', aliases = []`)
    .collect();
  await db
    .query(
      surql`CREATE episode:ep1 SET kind='session', title='t', started_at=time::now(), summary='s'`,
    )
    .collect();
  await db
    .query(
      surql`CREATE capture:c1 SET body='hi', kind='fact', origin='user', source='cli', ts=time::now()`,
    )
    .collect();
  await db.query('RELATE episode:ep1->derived_from->capture:c1').collect();

  // Wrap in the same shape that openV1 returns so phases work unchanged.
  return {
    raw: db,
    query: (sql, ...args) => db.query(sql, ...args),
    close: async () => close(db),
  };
}

const stubEmbedder = {
  dimension: 1024,
  embed: async () => new Float32Array(1024).fill(0.1),
  embedBatch: async (texts) => texts.map(() => new Float32Array(1024).fill(0.1)),
};

test('end-to-end: 1 entity + 1 episode + 1 capture migrate, capture gets episode_id', async () => {
  setupTestHome();
  const v1Handle = await openSeededV1();

  const v2 = await connect({ engine: 'mem://' });
  try {
    await runMigrations(v2, paths().migrationsDir);
    const result = await runMigration({
      v1Handle,
      v2db: v2,
      embedder: stubEmbedder,
      log: () => {},
    });

    assert.equal(result.phases.entity.imported, 1);
    assert.equal(result.phases.episode.imported, 1);
    assert.equal(result.phases.capture.imported, 1);

    const [evs] = await v2
      .query(`SELECT episode_id, content, meta FROM events WHERE meta.from_v1.v1_table = 'capture'`)
      .collect();
    assert.equal(evs[0].content, 'hi');
    assert.ok(String(evs[0].episode_id).startsWith('episodes:'), 'episode_id resolved');
  } finally {
    await close(v2);
  }
});

test('idempotent re-run: 0 net imports on second pass', async () => {
  setupTestHome();

  const v2 = await connect({ engine: 'mem://' });
  try {
    await runMigrations(v2, paths().migrationsDir);

    // First run
    const v1First = await openSeededV1();
    await runMigration({ v1Handle: v1First, v2db: v2, embedder: stubEmbedder, log: () => {} });

    // Second run: completed_phases short-circuits everything.
    const v1Second = await openSeededV1();
    const second = await runMigration({
      v1Handle: v1Second,
      v2db: v2,
      embedder: stubEmbedder,
      log: () => {},
    });

    for (const ph of ['entity', 'episode', 'capture', 'edges', 'lossy']) {
      assert.ok(second.phases[ph]?.alreadyDone, `expected ${ph} alreadyDone on second run`);
    }
  } finally {
    await close(v2);
  }
});

test('--only runs a single phase', async () => {
  setupTestHome();
  const v1Handle = await openSeededV1();

  const v2 = await connect({ engine: 'mem://' });
  try {
    await runMigrations(v2, paths().migrationsDir);
    const r = await runMigration({
      v1Handle,
      v2db: v2,
      embedder: stubEmbedder,
      only: 'entity',
      log: () => {},
    });

    assert.equal(r.phases.entity.imported, 1);
    assert.equal(Object.keys(r.phases).length, 1);

    // capture phase did NOT run — events table has no captures
    const [caps] = await v2
      .query(`SELECT count() AS n FROM events WHERE meta.from_v1.v1_table = 'capture' GROUP ALL`)
      .collect();
    assert.equal(caps[0]?.n ?? 0, 0);
  } finally {
    await close(v2);
  }
});
