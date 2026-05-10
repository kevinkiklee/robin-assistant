import { surql } from 'surrealdb';
import { requireSecret, saveSecret } from '../../secrets/dotenv-io.js';

const BACKOFF_THRESHOLD = 3;
const BACKOFF_MAX_MS = 24 * 3_600_000;

async function readIntegrationRow(db, name) {
  const [rows] = await db
    .query(surql`SELECT * FROM type::record('runtime', 'scheduler')`)
    .collect();
  return rows[0]?.value?.integrations?.[name] ?? null;
}

async function writeIntegrationRow(db, name, fields) {
  const cur = (await readIntegrationRow(db, name)) ?? {};
  const next = { ...cur, ...fields };
  const [rows] = await db
    .query(surql`SELECT * FROM type::record('runtime', 'scheduler')`)
    .collect();
  const value = rows[0]?.value ?? {};
  const integrations = { ...(value.integrations ?? {}), [name]: next };
  await db
    .query(
      surql`UPSERT type::record('runtime', 'scheduler') SET value = ${{ ...value, integrations }}`,
    )
    .collect();
}

function effectiveCadenceMs(row) {
  const base = row.cadence_ms;
  const failures = row.consecutive_failures ?? 0;
  if (failures < BACKOFF_THRESHOLD) return base;
  const multiplier = 2 ** (failures - BACKOFF_THRESHOLD + 1);
  return Math.min(base * multiplier, BACKOFF_MAX_MS);
}

export async function runIntegrationSync(db, registry, name, { manual = false } = {}) {
  const cur = await readIntegrationRow(db, name);
  if (!cur) throw new Error(`integration not registered: ${name}`);
  if (cur.in_flight) {
    return { ok: false, reason: 'in_flight', started_at: cur.in_flight_started_at };
  }
  const integration = registry.get(name);
  if (!integration) throw new Error(`integration manifest not loaded: ${name}`);
  if (integration.cadence_ms === null) {
    return { ok: false, reason: 'gateway_no_sync' };
  }

  await writeIntegrationRow(db, name, {
    in_flight: true,
    in_flight_started_at: new Date(),
  });

  const trigger = manual ? 'manual sync started by tool' : 'scheduled tick fired sync';
  console.log(`[integrations:${name}] ${trigger}`);

  const ctrl = new AbortController();
  const startMs = Date.now();
  try {
    const secrets = {};
    for (const key of integration.secrets?.env_keys ?? []) {
      Object.defineProperty(secrets, key, {
        get: () => requireSecret(key),
        enumerable: true,
      });
    }
    const ctx = {
      secrets,
      saveSecret,
      log: (...args) => console.log(`[integrations:${name}]`, ...args),
      cursor: cur.cursor ?? null,
      capture: integration.capture,
      signal: ctrl.signal,
      fetchFn: integration.fetchFn ?? globalThis.fetch,
    };
    const result = await integration.sync(ctx);
    const durationMs = Date.now() - startMs;
    await writeIntegrationRow(db, name, {
      in_flight: false,
      in_flight_started_at: null,
      last_sync_at: new Date(),
      last_sync_ok: true,
      last_sync_error: null,
      last_sync_count: result?.count ?? 0,
      consecutive_failures: 0,
      cursor: result?.cursor ?? null,
      next_run_at: new Date(Date.now() + cur.cadence_ms),
    });
    return {
      ok: true,
      count: result?.count ?? 0,
      cursor: result?.cursor ?? null,
      duration_ms: durationMs,
    };
  } catch (e) {
    const failures = manual ? (cur.consecutive_failures ?? 0) : (cur.consecutive_failures ?? 0) + 1;
    const cadence = effectiveCadenceMs({
      cadence_ms: cur.cadence_ms,
      consecutive_failures: failures,
    });
    await writeIntegrationRow(db, name, {
      in_flight: false,
      in_flight_started_at: null,
      last_sync_at: new Date(),
      last_sync_ok: false,
      last_sync_error: e.message,
      consecutive_failures: failures,
      next_run_at: manual ? cur.next_run_at : new Date(Date.now() + cadence),
    });
    return { ok: false, reason: 'sync_error', error: e.message };
  }
}
