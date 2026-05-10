import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { runIntegrationSync } from '../../src/integrations/_framework/run-sync.js';
import { createIntegrationRunTool } from '../../src/mcp/tools/integration-run.js';
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

test('integration_run → runIntegrationSync → integration_status reflects update', async () => {
  const db = await fresh();
  // Seed scheduler row
  await db
    .query(
      surql`UPSERT type::record('runtime', 'scheduler') SET value = ${{
        integrations: { gmail: { cadence_ms: 900_000, consecutive_failures: 0 } },
      }}`,
    )
    .collect();

  const registry = new Map([
    [
      'gmail',
      {
        cadence_ms: 900_000,
        sync: async () => ({ count: 7, cursor: { history_id: 'h-99' } }),
      },
    ],
  ]);

  const runTool = createIntegrationRunTool({ db, registry, runIntegrationSync });
  const statusTool = createIntegrationStatusTool({ db });

  const before = await statusTool.handler({ name: 'gmail' });
  assert.equal(before.integration.last_sync_at ?? null, null);

  const r = await runTool.handler({ name: 'gmail' });
  assert.equal(r.ok, true);
  assert.equal(r.count, 7);

  const after = await statusTool.handler({ name: 'gmail' });
  assert.equal(after.integration.last_sync_ok, true);
  assert.equal(after.integration.last_sync_count, 7);
  assert.deepEqual(after.integration.cursor, { history_id: 'h-99' });
  await close(db);
});
