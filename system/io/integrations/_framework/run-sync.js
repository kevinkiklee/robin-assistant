import { surql } from 'surrealdb';
import { requireSecret, saveSecret } from '../../../config/secrets.js';

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

/**
 * If a manifest declares `quiet_window: { tz, active_hours }`, advance
 * `nextRunAt` forward in 1-hour steps until it falls inside `active_hours`
 * in the configured timezone. Used to gate integrations whose upstream is
 * only meaningful during specific local hours (e.g. Whoop overnight
 * recovery scores finalize 4-9am local). Caller passes the computed
 * scheduler tick; we never roll backward, only forward (up to 48h, which
 * covers any 1+ hour active window plus DST gaps).
 */
export function adjustForQuietWindow(nextRunAt, quietWindow) {
  if (!quietWindow) return nextRunAt;
  const { tz, active_hours } = quietWindow;
  if (!Array.isArray(active_hours) || active_hours.length === 0) return nextRunAt;
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: 'numeric',
    hour12: false,
  });
  let candidate = new Date(nextRunAt);
  for (let i = 0; i < 48; i++) {
    // `hour: numeric` in en-US can yield "24" for midnight; normalize to 0.
    const raw = Number.parseInt(formatter.format(candidate), 10);
    const hour = raw === 24 ? 0 : raw;
    if (active_hours.includes(hour)) return candidate;
    candidate = new Date(candidate.getTime() + 60 * 60_000);
  }
  return candidate;
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
  // Optional backstop timeout — integrations are free to ignore the signal,
  // but if they propagate it (lunch_money, google_calendar, etc.) we can
  // abort a runaway sync before it blocks the scheduler forever. Opt-in
  // because integrations with legitimate >5 min paginated syncs exist;
  // setting $ROBIN_INTEGRATION_TIMEOUT_MS=300000 enables a 5-min cap.
  const explicitTimeout = Number.parseInt(process.env.ROBIN_INTEGRATION_TIMEOUT_MS ?? '', 10);
  let timeoutHandle = null;
  if (Number.isInteger(explicitTimeout) && explicitTimeout > 0) {
    timeoutHandle = setTimeout(
      () => ctrl.abort(new Error(`integration ${name} exceeded ${explicitTimeout}ms`)),
      explicitTimeout,
    );
  }
  const startMs = Date.now();
  let cleared = false;
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
    const next_run_at = adjustForQuietWindow(
      new Date(Date.now() + cur.cadence_ms),
      integration.quiet_window ?? null,
    );
    await writeIntegrationRow(db, name, {
      in_flight: false,
      in_flight_started_at: null,
      last_sync_at: new Date(),
      last_sync_ok: true,
      last_sync_error: null,
      last_sync_count: result?.count ?? 0,
      consecutive_failures: 0,
      cursor: result?.cursor ?? null,
      next_run_at,
    });
    cleared = true;
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
    cleared = true;
    return { ok: false, reason: 'sync_error', error: e.message };
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    // Defense in depth: if the try/catch writeIntegrationRow itself threw
    // (DB transient, transaction conflict), in_flight would stay true and
    // wedge the dispatcher until daemon restart. Force-clear so the next
    // tick can dispatch. Watchdog invariant catches the case where the
    // handler never returns at all (this finally never fires).
    if (!cleared) {
      try {
        await writeIntegrationRow(db, name, {
          in_flight: false,
          in_flight_started_at: null,
          last_sync_at: new Date(),
          last_sync_ok: false,
          last_sync_error: '[finally-cleanup: bookkeeping write failed]',
          consecutive_failures: (cur.consecutive_failures ?? 0) + 1,
          next_run_at: new Date(Date.now() + cur.cadence_ms),
        });
      } catch (cleanupErr) {
        console.warn(`[integrations:${name}] finally-cleanup failed: ${cleanupErr.message}`);
      }
    }
  }
}
