import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createCalendarListEventsTool } from '../../src/integrations/google_calendar/tools/calendar-list-events.js';
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

test('calendar_list_events filters by source', async () => {
  const db = await fresh();
  await db
    .query(
      surql`CREATE events CONTENT ${{
        source: 'google_calendar',
        content: 'Meeting · 2026-05-09',
        ts: new Date('2026-05-09T10:00:00Z'),
        meta: { event_id: 'e1' },
      }}`,
    )
    .collect();
  await db
    .query(
      surql`CREATE events CONTENT ${{
        source: 'gmail',
        content: 'unrelated',
        ts: new Date(),
        meta: {},
      }}`,
    )
    .collect();
  const t = createCalendarListEventsTool({ db });
  const r = await t.handler({});
  assert.equal(r.events.length, 1);
  assert.match(r.events[0].content, /Meeting/);
  await close(db);
});

test('calendar_list_events filters by since/until', async () => {
  const db = await fresh();
  await db
    .query(
      surql`CREATE events CONTENT ${{
        source: 'google_calendar',
        content: 'past',
        ts: new Date('2026-04-01T00:00:00Z'),
        meta: {},
      }}`,
    )
    .collect();
  await db
    .query(
      surql`CREATE events CONTENT ${{
        source: 'google_calendar',
        content: 'recent',
        ts: new Date('2026-05-09T00:00:00Z'),
        meta: {},
      }}`,
    )
    .collect();
  const t = createCalendarListEventsTool({ db });
  const r = await t.handler({ since: '2026-05-01T00:00:00Z' });
  assert.equal(r.events.length, 1);
  assert.match(r.events[0].content, /recent/);
  await close(db);
});
