import assert from 'node:assert/strict';
import { mkdirSync as __robinMkdirSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir as __robinTmpdir, tmpdir } from 'node:os';
import { join as __robinJoin, join, resolve } from 'node:path';
import { mock, test } from 'node:test';
import { surql } from 'surrealdb';
import { writeConfig as __robinWriteConfig } from '../../config/paths.js';
import { close, connect } from '../../data/db/client.js';
import { runMigrations } from '../../data/db/migrate.js';
import { _resetCache } from '../../io/integrations/_auth/token-cache.js';

// __robin_test_home_setup__
const __robinTestHome = __robinJoin(
  __robinTmpdir(),
  `robin-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
);
__robinMkdirSync(__robinTestHome, { recursive: true });
process.env.ROBIN_HOME = __robinTestHome;
await __robinWriteConfig({ embedder_profile: 'mxbai-1024' });

let tmpHome;

test.beforeEach(() => {
  tmpHome = join(tmpdir(), `robin-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpHome, { recursive: true });
  process.env.ROBIN_HOME = tmpHome;
  writeFileSync(join(tmpHome, 'config.json'), JSON.stringify({ embedder_profile: 'mxbai-1024' }));
  _resetCache('google');
});

test.afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.ROBIN_HOME;
});

async function fresh() {
  const db = await connect({ engine: 'mem://' });
  await runMigrations(db, resolve(import.meta.dirname, '../../data/db/migrations'));
  return db;
}

async function seedScheduler(db, name, fields = {}) {
  const merged = { cadence_ms: 86_400_000, consecutive_failures: 0, ...fields };
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

test('GA4 403 PERMISSION_DENIED: failure logs re-auth instruction, increments consecutive_failures, then succeeds after re-auth', async () => {
  // Seed required secrets via dotenv-io (fresh import per test for ROBIN_HOME).
  const { saveSecret } = await import(`../../config/secrets.js?cb=${Date.now()}`);
  saveSecret('GA_PROPERTIES', '12345');
  saveSecret('GOOGLE_OAUTH_REFRESH_TOKEN', 'r');
  saveSecret('GOOGLE_OAUTH_CLIENT_ID', 'c');
  saveSecret('GOOGLE_OAUTH_CLIENT_SECRET', 's');
  const { sync } = await import(`../../io/integrations/ga/sync.js?cb=${Date.now()}`);
  const { runIntegrationSync } = await import(
    `../../io/integrations/_framework/run-sync.js?cb=${Date.now()}`
  );

  const db = await fresh();
  await seedScheduler(db, 'ga');

  // Capture log messages emitted via ctx.log (run-sync wraps as console.log).
  const logged = [];
  const origConsoleLog = console.log;
  console.log = (...args) => {
    logged.push(args.join(' '));
  };

  let scopeFailureActive = true;
  const fetchFn = mock.fn(async (url) => {
    if (url.includes('/token')) {
      return { ok: true, json: async () => ({ access_token: 'a', expires_in: 3600 }) };
    }
    if (url.includes(':runReport')) {
      if (scopeFailureActive) {
        return {
          ok: false,
          status: 403,
          text: async () =>
            '{"error":{"status":"PERMISSION_DENIED","message":"insufficient scope"}}',
          json: async () => null,
        };
      }
      return {
        ok: true,
        json: async () => ({
          rows: [
            {
              dimensionValues: [{ value: '20260510' }],
              metricValues: [
                { value: '100' },
                { value: '50' },
                { value: '120' },
                { value: '500' },
                { value: '0.4' },
                { value: '120' },
              ],
            },
          ],
        }),
      };
    }
    throw new Error(`unexpected: ${url}`);
  });

  // Build a registry entry that delegates to the real GA sync but injects
  // our fetchFn (run-sync respects integration.fetchFn if set).
  const registry = new Map([
    [
      'ga',
      {
        cadence_ms: 86_400_000,
        sync,
        fetchFn,
        capture: async () => ({}),
        secrets: {
          env_keys: [
            'GOOGLE_OAUTH_REFRESH_TOKEN',
            'GOOGLE_OAUTH_CLIENT_ID',
            'GOOGLE_OAUTH_CLIENT_SECRET',
          ],
        },
      },
    ],
  ]);

  try {
    // First sync — scope error path.
    const r1 = await runIntegrationSync(db, registry, 'ga');
    assert.equal(r1.ok, false);
    assert.equal(r1.reason, 'sync_error');
    assert.match(r1.error, /403/);

    const [rows1] = await db
      .query(surql`SELECT * FROM type::record('runtime', 'scheduler')`)
      .collect();
    const row1 = rows1[0].value.integrations.ga;
    assert.equal(row1.last_sync_ok, false);
    assert.equal(row1.consecutive_failures, 1, 'consecutive_failures incremented');
    assert.match(row1.last_sync_error ?? '', /403/);
    // Re-auth instruction logged via ctx.log → console.log.
    assert.ok(
      logged.some((m) => /robin auth google --code/.test(m)),
      'expected re-auth instruction in log output',
    );

    // Simulate re-auth: persist the new refresh token, clear cache, succeed.
    saveSecret('GOOGLE_OAUTH_REFRESH_TOKEN', 'r-new');
    _resetCache('google');
    scopeFailureActive = false;

    const r2 = await runIntegrationSync(db, registry, 'ga');
    assert.equal(r2.ok, true);
    assert.equal(r2.count, 1);

    const [rows2] = await db
      .query(surql`SELECT * FROM type::record('runtime', 'scheduler')`)
      .collect();
    const row2 = rows2[0].value.integrations.ga;
    assert.equal(row2.last_sync_ok, true);
    assert.equal(row2.consecutive_failures, 0, 'consecutive_failures reset on success');
    assert.equal(row2.last_sync_count, 1);
  } finally {
    console.log = origConsoleLog;
    await close(db);
  }
});
