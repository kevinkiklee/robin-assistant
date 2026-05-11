import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { writeConfig as __robinWriteConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { createNhlRecentTool } from '../../io/integrations/nhl/tools/nhl-recent.js';
import { createNhlStandingsTool } from '../../io/integrations/nhl/tools/nhl-standings.js';

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
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  return db;
}

test('nhl_recent returns games filtered by team', async () => {
  const db = await fresh();
  await db
    .query(
      surql`CREATE events CONTENT ${{
        source: 'nhl',
        content: 'NYR @ BOS · 2026-05-09 · 4-2 FINAL',
        ts: new Date('2026-05-09T23:00:00Z'),
        meta: { kind: 'game', team: 'NYR', away: 'NYR', home: 'BOS' },
      }}`,
    )
    .collect();
  await db
    .query(
      surql`CREATE events CONTENT ${{
        source: 'nhl',
        content: 'TOR @ MTL · 2026-05-09 · 3-1 FINAL',
        ts: new Date('2026-05-09T23:00:00Z'),
        meta: { kind: 'game', team: 'TOR', away: 'TOR', home: 'MTL' },
      }}`,
    )
    .collect();
  const t = createNhlRecentTool({ db });
  const r = await t.handler({ team: 'NYR' });
  assert.equal(r.games.length, 1);
  assert.match(r.games[0].content, /NYR @ BOS/);
  await close(db);
});

test('nhl_standings returns the most recent standings event', async () => {
  const db = await fresh();
  await db
    .query(
      surql`CREATE events CONTENT ${{
        source: 'nhl',
        content: 'NHL standings (2026-05-09): Metropolitan: NYR (100p)',
        ts: new Date('2026-05-09T00:00:00Z'),
        meta: { kind: 'standings', date: '2026-05-09', divisions: [] },
      }}`,
    )
    .collect();
  const t = createNhlStandingsTool({ db });
  const r = await t.handler({});
  assert.ok(r.standings);
  assert.match(r.standings.content, /Metropolitan/);
  await close(db);
});
