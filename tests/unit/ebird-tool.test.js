import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createEbirdRecentTool } from '../../src/integrations/ebird/tools/ebird-recent.js';

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

test('ebird_recent returns rows ordered by ts desc', async () => {
  const db = await fresh();
  await db
    .query(
      surql`CREATE events CONTENT ${{
        source: 'ebird',
        content: 'American Robin at Central Park · 2026-05-09 10:00',
        ts: new Date('2026-05-09T10:00:00Z'),
        external_id: 'ebird:S111',
        meta: { common_name: 'American Robin', location_id: 'L191106' },
      }}`,
    )
    .collect();
  await db
    .query(
      surql`CREATE events CONTENT ${{
        source: 'ebird',
        content: 'Northern Cardinal at Prospect Park · 2026-05-08 09:00',
        ts: new Date('2026-05-08T09:00:00Z'),
        external_id: 'ebird:S222',
        meta: { common_name: 'Northern Cardinal', location_id: 'L92485' },
      }}`,
    )
    .collect();
  const t = createEbirdRecentTool({ db });
  const r = await t.handler({ days: 30 });
  assert.equal(r.observations.length, 2);
  assert.match(r.observations[0].content, /Robin/);
});

test('ebird_recent filters by location_id', async () => {
  const db = await fresh();
  await db
    .query(
      surql`CREATE events CONTENT ${{
        source: 'ebird',
        content: 'a',
        ts: new Date(),
        external_id: 'ebird:a',
        meta: { location_id: 'L191106' },
      }}`,
    )
    .collect();
  await db
    .query(
      surql`CREATE events CONTENT ${{
        source: 'ebird',
        content: 'b',
        ts: new Date(),
        external_id: 'ebird:b',
        meta: { location_id: 'L92485' },
      }}`,
    )
    .collect();
  const t = createEbirdRecentTool({ db });
  const r = await t.handler({ days: 30, location_id: 'L191106' });
  assert.equal(r.observations.length, 1);
  await close(db);
});
