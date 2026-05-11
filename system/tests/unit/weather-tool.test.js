import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync } from 'node:fs';
import { tmpdir as __robinTmpdir } from 'node:os';
import { join as __robinJoin, resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createWeatherTodayTool } from '../../src/integrations/weather/tools/weather-today.js';
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

test('weather_today returns latest weather event', async () => {
  const db = await fresh();
  await db
    .query(
      surql`CREATE events CONTENT ${{
        source: 'weather',
        content: 'NYC · 70°F / 50°F · Clear',
        ts: new Date('2026-05-10T12:00:00Z'),
        meta: { location_name: 'NYC' },
      }}`,
    )
    .collect();
  await db
    .query(
      surql`CREATE events CONTENT ${{
        source: 'weather',
        content: 'NYC · 65°F / 48°F · Rain',
        ts: new Date('2026-05-09T12:00:00Z'),
        meta: { location_name: 'NYC' },
      }}`,
    )
    .collect();
  const t = createWeatherTodayTool({ db });
  const r = await t.handler({});
  assert.ok(r.weather);
  assert.match(r.weather.content, /70°F/);
  await close(db);
});

test('weather_today returns null when no captures exist', async () => {
  const db = await fresh();
  const t = createWeatherTodayTool({ db });
  const r = await t.handler({});
  assert.equal(r.weather, null);
  await close(db);
});
