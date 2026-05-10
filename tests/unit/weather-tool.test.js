import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { surql } from 'surrealdb';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createWeatherTodayTool } from '../../src/integrations/weather/tools/weather-today.js';

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
        external_id: 'weather:2026-05-10',
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
        external_id: 'weather:2026-05-09',
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
