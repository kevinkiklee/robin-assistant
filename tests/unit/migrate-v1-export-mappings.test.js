import assert from 'node:assert';
import { mkdtempSync, readFileSync } from 'node:fs';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { join as __robinJoin } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { exportMappings } from '../../src/migrate-v1/export-mappings.js';
import { writeConfig as __robinWriteConfig } from '../../src/runtime/config.js';
import { paths } from '../../src/runtime/data-store.js';

// __robin_test_home_setup__
const __robinTestHome = __robinJoin(
  tmpdir(),
  `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
);
__robinMkdirSync(__robinTestHome, { recursive: true });
process.env.ROBIN_HOME = __robinTestHome;
await __robinWriteConfig({ embedder_profile: 'mxbai-1024' });

test('exportMappings writes JSON keyed by entities/episodes/events', async () => {
  const db = await connect({ engine: 'mem://' });
  try {
    await runMigrations(db, paths.source.migrations());
    // Create one entity + one event with from_v1 audit
    await db
      .query(
        surql`CREATE entities CONTENT ${{
          name: 'Eric',
          type: 'person',
          embedding: new Array(1024).fill(0),
          meta: { from_v1: { v1_table: 'entity', v1_id: 'entity:e1', source_hash: 'h' } },
        }}`,
      )
      .collect();
    await db
      .query(
        surql`CREATE events CONTENT ${{
          content: 'hi',
          source: 'migration',
          content_hash: 'h',
          ts: new Date(),
          trust: 'trusted',
          meta: { from_v1: { v1_table: 'capture', v1_id: 'capture:c1', source_hash: 'h2' } },
        }}`,
      )
      .collect();

    const out = mkdtempSync(join(tmpdir(), 'map-'));
    const path = join(out, 'mappings.json');
    await exportMappings(db, path);
    const data = JSON.parse(readFileSync(path, 'utf-8'));
    assert.ok(data.entities);
    assert.ok(data.events);
    assert.match(data.entities['entity:e1'], /^entities:/);
    assert.match(data.events['capture:c1'], /^events:/);
  } finally {
    await close(db);
  }
});

test('exportMappings on empty DB writes empty maps', async () => {
  const db = await connect({ engine: 'mem://' });
  try {
    await runMigrations(db, paths.source.migrations());
    const out = mkdtempSync(join(tmpdir(), 'map-empty-'));
    const path = join(out, 'mappings.json');
    await exportMappings(db, path);
    const data = JSON.parse(readFileSync(path, 'utf-8'));
    assert.deepEqual(data, { entities: {}, episodes: {}, events: {} });
  } finally {
    await close(db);
  }
});
