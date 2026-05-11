import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createLinearActiveIssuesTool } from '../../src/integrations/linear/tools/linear-active-issues.js';
import { createLinearGetIssueTool } from '../../src/integrations/linear/tools/linear-get-issue.js';
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

test('linear_active_issues filters by team', async () => {
  const db = await fresh();
  await db
    .query(
      surql`CREATE events CONTENT ${{
        source: 'linear',
        content: 'In Progress · High · Issue A',
        ts: new Date('2026-05-09T15:00:00Z'),
        meta: { identifier: 'ENG-1', team: 'ENG', state: 'In Progress' },
      }}`,
    )
    .collect();
  await db
    .query(
      surql`CREATE events CONTENT ${{
        source: 'linear',
        content: 'Todo · Medium · Issue B',
        ts: new Date('2026-05-08T15:00:00Z'),
        meta: { identifier: 'DESIGN-2', team: 'DESIGN', state: 'Todo' },
      }}`,
    )
    .collect();
  const t = createLinearActiveIssuesTool({ db });
  const r = await t.handler({ team: 'ENG' });
  assert.equal(r.issues.length, 1);
  assert.equal(r.issues[0].meta.identifier, 'ENG-1');
  await close(db);
});

test('linear_active_issues filters by assignee', async () => {
  const db = await fresh();
  await db
    .query(
      surql`CREATE events CONTENT ${{
        source: 'linear',
        content: 'a',
        ts: new Date(),
        meta: { identifier: 'A-1', assignee: 'Kevin' },
      }}`,
    )
    .collect();
  await db
    .query(
      surql`CREATE events CONTENT ${{
        source: 'linear',
        content: 'b',
        ts: new Date(),
        meta: { identifier: 'A-2', assignee: 'Other' },
      }}`,
    )
    .collect();
  const t = createLinearActiveIssuesTool({ db });
  const r = await t.handler({ assignee: 'Kevin' });
  assert.equal(r.issues.length, 1);
  await close(db);
});

test('linear_get_issue surfaces a clear error when secret missing', async () => {
  const { mkdtempSync: _mkdtemp, rmSync: _rm } = await import('node:fs');
  const { tmpdir: _tmpdir } = await import('node:os');
  const { join: _join } = await import('node:path');
  const t = createLinearGetIssueTool();
  // Use a fresh tmpdir so robinHome() resolves but LINEAR_API_KEY is absent.
  const home = _mkdtemp(_join(_tmpdir(), 'robin-linear-nokey-'));
  const prev = process.env.ROBIN_HOME;
  process.env.ROBIN_HOME = home;
  try {
    await assert.rejects(() => t.handler({ identifier: 'ENG-1' }), /linear not configured/);
  } finally {
    if (prev !== undefined) process.env.ROBIN_HOME = prev;
    else delete process.env.ROBIN_HOME;
    _rm(home, { recursive: true, force: true });
  }
});
