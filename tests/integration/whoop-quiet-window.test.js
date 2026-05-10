import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { mock, test } from 'node:test';
import { surql } from 'surrealdb';
import { close, connect } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { runIntegrationSync } from '../../src/integrations/_framework/run-sync.js';

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../src/schema/migrations'));
  return db;
}

async function seed(db, name, fields = {}) {
  const merged = { cadence_ms: 30 * 60 * 1000, consecutive_failures: 0, ...fields };
  const [rows] = await db
    .query(surql`SELECT * FROM type::record('runtime', 'scheduler')`)
    .collect();
  const value = rows[0]?.value ?? {};
  const integrations = { ...(value.integrations ?? {}), [name]: merged };
  await db
    .query(
      surql`UPSERT type::record('runtime', 'scheduler') SET value = ${{ ...value, integrations }}`,
    )
    .collect();
}

function hourInTz(d, tz) {
  const raw = Number.parseInt(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false }).format(d),
    10,
  );
  return raw === 24 ? 0 : raw;
}

test('whoop sync at 8:50am EDT advances next_run_at to next active window (4-8am EDT)', async () => {
  const db = await fresh();
  await seed(db, 'whoop');

  // Pin "now" to 8:50am EDT (12:50 UTC during EDT). Adding the 30m cadence
  // produces 9:20am EDT — outside the [4,5,6,7,8] active window — so the
  // framework must advance forward to the next 4am EDT.
  const at850amEDT = new Date('2026-05-10T12:50:00Z');
  mock.timers.enable({ apis: ['Date'], now: at850amEDT });

  try {
    const registry = new Map([
      [
        'whoop',
        {
          cadence_ms: 30 * 60 * 1000,
          quiet_window: { tz: 'America/New_York', active_hours: [4, 5, 6, 7, 8] },
          sync: async () => ({ count: 0, cursor: null }),
        },
      ],
    ]);

    const r = await runIntegrationSync(db, registry, 'whoop');
    assert.equal(r.ok, true);

    const [rows] = await db
      .query(surql`SELECT * FROM type::record('runtime', 'scheduler')`)
      .collect();
    const row = rows[0].value.integrations.whoop;
    const nextRunAt = new Date(row.next_run_at);
    const tz = 'America/New_York';
    const adjustedHour = hourInTz(nextRunAt, tz);
    assert.ok(
      [4, 5, 6, 7, 8].includes(adjustedHour),
      `next_run_at should land in active window; got hour ${adjustedHour}`,
    );
    // Advanced forward, not backward.
    assert.ok(nextRunAt.getTime() > at850amEDT.getTime(), 'next_run_at advanced forward');
    // 8:50am EDT + 30m = 9:20am EDT (outside). Next active hour is 4am EDT
    // the following day, ~18.5-19.5h ahead.
    const deltaHours = (nextRunAt.getTime() - at850amEDT.getTime()) / 3_600_000;
    assert.ok(deltaHours >= 18 && deltaHours <= 21, `expected ~19h advance, got ${deltaHours}h`);
    // Specifically: lands on the FIRST active hour reached (4am EDT).
    assert.equal(adjustedHour, 4, 'next_run_at lands on 4am EDT (first active hour)');
  } finally {
    mock.timers.reset();
    await close(db);
  }
});

test('whoop sync inside active window keeps next_run_at unchanged from base cadence', async () => {
  const db = await fresh();
  await seed(db, 'whoop');

  // 5am EDT = 09:00 UTC during EDT. Inside the window, plus 30m → 5:30am
  // (still inside), so no quiet-window advance.
  const at5amEDT = new Date('2026-05-10T09:00:00Z');
  mock.timers.enable({ apis: ['Date'], now: at5amEDT });

  try {
    const registry = new Map([
      [
        'whoop',
        {
          cadence_ms: 30 * 60 * 1000,
          quiet_window: { tz: 'America/New_York', active_hours: [4, 5, 6, 7, 8] },
          sync: async () => ({ count: 0, cursor: null }),
        },
      ],
    ]);

    const r = await runIntegrationSync(db, registry, 'whoop');
    assert.equal(r.ok, true);

    const [rows] = await db
      .query(surql`SELECT * FROM type::record('runtime', 'scheduler')`)
      .collect();
    const row = rows[0].value.integrations.whoop;
    const nextRunAt = new Date(row.next_run_at);
    const expected = new Date(at5amEDT.getTime() + 30 * 60 * 1000);
    assert.equal(
      nextRunAt.getTime(),
      expected.getTime(),
      'inside-window: next_run_at == now + cadence (no advance)',
    );
  } finally {
    mock.timers.reset();
    await close(db);
  }
});
