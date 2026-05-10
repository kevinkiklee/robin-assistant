import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createIntegrationRunTool } from '../../src/mcp/tools/integration-run.js';

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return db;
}

test('integration_run rejects unknown integration', async () => {
  const db = await fresh();
  const t = createIntegrationRunTool({
    db,
    registry: new Map(),
    runIntegrationSync: async () => {},
  });
  const r = await t.handler({ name: 'nope' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unknown_integration');
  await close(db);
});

test('integration_run rejects gateway integration', async () => {
  const db = await fresh();
  const registry = new Map([['discord', { cadence_ms: null }]]);
  const t = createIntegrationRunTool({ db, registry, runIntegrationSync: async () => {} });
  const r = await t.handler({ name: 'discord' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'gateway_no_sync');
  await close(db);
});

test('integration_run refuses too_recent', async () => {
  const db = await fresh();
  await db
    .query(
      surql`UPSERT type::record('runtime', 'scheduler') SET value = ${{
        integrations: { gmail: { cadence_ms: 900_000, last_sync_at: new Date() } },
      }}`,
    )
    .collect();
  const registry = new Map([['gmail', { cadence_ms: 900_000 }]]);
  const t = createIntegrationRunTool({
    db,
    registry,
    runIntegrationSync: async () => ({ ok: true }),
  });
  const r = await t.handler({ name: 'gmail' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'too_recent');
  await close(db);
});

test('integration_run delegates to runIntegrationSync with manual: true', async () => {
  const db = await fresh();
  let called;
  const registry = new Map([['gmail', { cadence_ms: 900_000 }]]);
  const t = createIntegrationRunTool({
    db,
    registry,
    runIntegrationSync: async (_db, _reg, name, opts) => {
      called = { name, opts };
      return { ok: true, count: 5, cursor: { x: 1 }, duration_ms: 100 };
    },
  });
  const r = await t.handler({ name: 'gmail' });
  assert.equal(r.ok, true);
  assert.equal(called.opts.manual, true);
  await close(db);
});
