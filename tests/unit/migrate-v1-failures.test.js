import assert from 'node:assert';
import { test } from 'node:test';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { clearFailures, listFailures, recordFailure } from '../../src/migrate-v1/failures.js';
import { paths } from '../../src/runtime/data-store.js';

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

test('recordFailure appends to runtime:migration_failures.value.entries', async () => {
  const db = await connect({ engine: 'mem://' });
  try {
    await runMigrations(db, paths().migrationsDir);
    await recordFailure(db, {
      v1_table: 'capture',
      v1_id: 'capture:bad1',
      error_message: 'assert failed',
    });
    await recordFailure(db, {
      v1_table: 'entity',
      v1_id: 'entity:bad1',
      error_message: 'name empty',
      phase: 'entity',
    });
    const out = await listFailures(db);
    assert.equal(out.length, 2);
    assert.equal(out[0].v1_table, 'capture');
    assert.ok(out[0].occurred_at);
  } finally {
    await close(db);
  }
});

test('listFailures filters by phase', async () => {
  const db = await connect({ engine: 'mem://' });
  try {
    await runMigrations(db, paths().migrationsDir);
    await recordFailure(db, {
      v1_table: 'capture',
      v1_id: 'c1',
      error_message: 'x',
      phase: 'capture',
    });
    await recordFailure(db, {
      v1_table: 'entity',
      v1_id: 'e1',
      error_message: 'y',
      phase: 'entity',
    });
    const filtered = await listFailures(db, { phase: 'entity' });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].v1_table, 'entity');
  } finally {
    await close(db);
  }
});

test('clearFailures empties the row', async () => {
  const db = await connect({ engine: 'mem://' });
  try {
    await runMigrations(db, paths().migrationsDir);
    await recordFailure(db, { v1_table: 't', v1_id: 't:1', error_message: 'x' });
    await clearFailures(db);
    assert.equal((await listFailures(db)).length, 0);
  } finally {
    await close(db);
  }
});
