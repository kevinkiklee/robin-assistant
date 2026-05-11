// outbound-private-block.test.js — Theme 1c: the bug-fix gate. Verifies
// that checkOutboundScope refuses to forward payloads referencing private
// memos (direct and transitive via derived_from).

import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import * as store from '../../src/memory/store.js';
import { checkOutboundScope } from '../../src/outbound/policy.js';
import { writeConfig } from '../../src/runtime/config.js';

const home = join(tmpdir(), `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
mkdirSync(home, { recursive: true });
process.env.ROBIN_HOME = home;
await writeConfig({ embedder_profile: 'mxbai-1024' });

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return db;
}

const embedder = { embed: async () => new Float32Array(1024) };

test('checkOutboundScope blocks direct private-scope ref', async () => {
  const db = await fresh();
  const m = await store.note(db, embedder, 'knowledge', {
    content: 'secret',
    derived_by: 'manual',
    scope: 'private',
  });
  const r = await checkOutboundScope(db, { tool: 'discord_send', refs: [m.id] });
  assert.equal(r.ok, false);
  assert.match(r.reason, /private/);

  const [refusals] = await db
    .query(`SELECT reason FROM refusals WHERE reason = 'private_scope'`)
    .collect();
  assert.equal(refusals.length, 1);
});

test('checkOutboundScope allows non-blocked scopes', async () => {
  const db = await fresh();
  const m = await store.note(db, embedder, 'knowledge', {
    content: 'public',
    derived_by: 'manual',
    scope: 'global',
  });
  const r = await checkOutboundScope(db, { tool: 'discord_send', refs: [m.id] });
  assert.equal(r.ok, true);
});

test('checkOutboundScope handles empty refs', async () => {
  const db = await fresh();
  const r = await checkOutboundScope(db, { tool: 'x', refs: [] });
  assert.equal(r.ok, true);
});
