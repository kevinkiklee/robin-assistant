import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createLinearActiveIssuesTool } from '../../src/integrations/linear/tools/linear-active-issues.js';
import { createLinearGetIssueTool } from '../../src/integrations/linear/tools/linear-get-issue.js';

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
        external_id: 'linear:ENG-1',
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
        external_id: 'linear:DESIGN-2',
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
        external_id: 'linear:A-1',
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
        external_id: 'linear:A-2',
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
  const t = createLinearGetIssueTool();
  // Use a deterministic ROBIN_HOME so requireSecret can resolve a path that
  // doesn't have LINEAR_API_KEY set.
  const prev = process.env.ROBIN_HOME;
  process.env.ROBIN_HOME = '/tmp/robin-linear-test-nokey';
  try {
    await assert.rejects(() => t.handler({ identifier: 'ENG-1' }), /linear not configured/);
  } finally {
    if (prev === undefined) {
      process.env.ROBIN_HOME = undefined;
    } else {
      process.env.ROBIN_HOME = prev;
    }
  }
});
