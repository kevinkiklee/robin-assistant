import assert from 'node:assert';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { runReset } from '../../src/migrate-v1/reset.js';
import { writeConfig } from '../../src/runtime/config.js';
import { paths } from '../../src/runtime/data-store.js';

test.beforeEach(() => {
  const tmpHome = join(tmpdir(), `robin-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpHome, { recursive: true });
  process.env.ROBIN_HOME = tmpHome;
});

async function seedMixed(db) {
  // 1 v1-migrated entity, 1 native entity (no from_v1)
  await db
    .query(
      surql`CREATE entities CONTENT ${{
        name: 'V1Eric',
        type: 'person',
        embedding: new Array(1024).fill(0),
        meta: { from_v1: { v1_table: 'entity', v1_id: 'entity:e1', source_hash: 'h1' } },
      }}`,
    )
    .collect();
  await db
    .query(
      surql`CREATE entities CONTENT ${{
        name: 'NativeBob',
        type: 'person',
        embedding: new Array(1024).fill(0),
        meta: {},
      }}`,
    )
    .collect();
}

test('--reset --phase entity removes only v1 entities', async () => {
  await writeConfig({ embedder_profile: 'mxbai-1024' });
  const db = await connect({ engine: 'mem://' });
  try {
    await runMigrations(db, paths.source.migrations());
    await seedMixed(db);
    await runReset(db, { phase: 'entity', dryRun: false, prompt: false });
    const [rows] = await db.query('SELECT name FROM entities').collect();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, 'NativeBob');
  } finally {
    await close(db);
  }
});

test('--reset (no phase) wipes all v1 rows + progress + id_map + failures', async () => {
  await writeConfig({ embedder_profile: 'mxbai-1024' });
  const db = await connect({ engine: 'mem://' });
  try {
    await runMigrations(db, paths.source.migrations());
    await seedMixed(db);
    await db
      .query(
        surql`UPSERT type::record('runtime', 'migration_progress') SET value = ${{ v1_to_v2: { started_at: 't' } }}`,
      )
      .collect();
    await db
      .query(
        surql`UPSERT type::record('runtime', 'migration_id_map') SET value = ${{ entity: { 'entity:e1': 'entities:abc' } }}`,
      )
      .collect();
    await runReset(db, { phase: null, dryRun: false, prompt: false });
    const [rows] = await db.query('SELECT name FROM entities').collect();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, 'NativeBob');
    const [prog] = await db
      .query("SELECT * FROM type::record('runtime', 'migration_progress')")
      .collect();
    assert.equal(prog.length, 0);
    const [idm] = await db
      .query("SELECT * FROM type::record('runtime', 'migration_id_map')")
      .collect();
    assert.equal(idm.length, 0);
  } finally {
    await close(db);
  }
});

test('--dry-run produces a plan without modifying state', async () => {
  await writeConfig({ embedder_profile: 'mxbai-1024' });
  const db = await connect({ engine: 'mem://' });
  try {
    await runMigrations(db, paths.source.migrations());
    await seedMixed(db);
    const r = await runReset(db, { phase: 'entity', dryRun: true, prompt: false });
    assert.equal(r.applied, false);
    assert.ok(Array.isArray(r.plan));
    const [rows] = await db.query('SELECT name FROM entities').collect();
    assert.equal(rows.length, 2); // unchanged
  } finally {
    await close(db);
  }
});

test('--reset --phase lossy:preference deletes only that kind', async () => {
  await writeConfig({ embedder_profile: 'mxbai-1024' });
  const db = await connect({ engine: 'mem://' });
  try {
    await runMigrations(db, paths.source.migrations());
    // ts has DEFAULT time::now() READONLY; embedding is option<array<float>> — omit both.
    await db
      .query(
        surql`CREATE events CONTENT ${{
          content: 'pref',
          source: 'migration',
          content_hash: 'hpref',
          meta: {
            kind: 'v1_preference',
            from_v1: { v1_table: 'preference', v1_id: 'preference:p1', source_hash: 'hpref' },
          },
        }}`,
      )
      .collect();
    await db
      .query(
        surql`CREATE events CONTENT ${{
          content: 'corr',
          source: 'migration',
          content_hash: 'hcorr',
          meta: {
            kind: 'v1_correction',
            from_v1: { v1_table: 'correction', v1_id: 'correction:c1', source_hash: 'hcorr' },
          },
        }}`,
      )
      .collect();
    await runReset(db, { phase: 'lossy:preference', dryRun: false, prompt: false });
    const [rows] = await db.query('SELECT meta.kind AS k FROM events ORDER BY meta.kind').collect();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].k, 'v1_correction');
  } finally {
    await close(db);
  }
});
