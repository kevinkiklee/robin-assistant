import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createIntegrationStatusTool } from '../../src/mcp/tools/integration-status.js';

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

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return db;
}

test('integration_status returns empty on fresh DB', async () => {
  const db = await fresh();
  const t = createIntegrationStatusTool({ db });
  const r = await t.handler({});
  assert.deepEqual(r.integrations, {});
  await close(db);
});

test('integration_status returns named row when name passed', async () => {
  const db = await fresh();
  await db
    .query(
      surql`UPSERT type::record('runtime', 'scheduler') SET value = ${{
        integrations: { gmail: { cadence_ms: 900_000, last_sync_ok: true } },
      }}`,
    )
    .collect();
  const t = createIntegrationStatusTool({ db });
  const r = await t.handler({ name: 'gmail' });
  assert.equal(r.integration.last_sync_ok, true);
  await close(db);
});

test('integration_status returns null for unknown name', async () => {
  const db = await fresh();
  const t = createIntegrationStatusTool({ db });
  const r = await t.handler({ name: 'nope' });
  assert.equal(r.integration, null);
  await close(db);
});
