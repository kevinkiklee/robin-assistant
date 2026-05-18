import { createNodeEngines } from '@surrealdb/node';
import { createRemoteEngines, Surreal } from 'surrealdb';
import { paths } from '../../config/data-store.js';
import { readConfig } from '../../config/paths.js';
import { log } from '../../runtime/log/index.js';

// Default engine when no `db.url`/`db.engine` is set in config.json.
//
// In normal operation `robin install` writes a `db.url: ws://...` pointing
// at the standalone SurrealDB server it installs and supervises (see
// system/runtime/cli/commands/surreal-install.js), so this default only
// kicks in for: install-time pre-config reads, `--no-surreal` opt-outs,
// and tests using ROBIN_HOME against a fresh tmp dir.
//
// Embedded engines accepted here: `mem`, `rocksdb`, `surrealkv`.
// `surrealkv+versioned` is intentionally NOT supported — the v3.0.4
// standalone binary doesn't accept that URL scheme, and the embedded NAPI
// variant hangs on connect in @surrealdb/node 3.0.3. Multi-writer setups
// must use the standalone server.
//
// system/runtime/scripts/start-surreal-server.mjs exists as a manual escape
// hatch for debugging; the canonical path is `robin install`.
const DEFAULT_ENGINE = 'surrealkv';

/**
 * Resolve the URL to use for the production DB based on the user's config.
 *
 * Reads, in order of precedence:
 *   1. `db.url`     — full URL override (e.g. "ws://127.0.0.1:8000"). When
 *                     present, this is returned verbatim — used for connecting
 *                     to a standalone SurrealDB server (the workaround for
 *                     the embedded surrealkv+versioned hang).
 *   2. `db.engine`  — embedded-engine scheme. Combined with the local DB path
 *                     to produce e.g. "surrealkv:///path/to/db".
 *   3. DEFAULT_ENGINE — current value: surrealkv.
 *
 * Pure path computation; doesn't connect.
 *
 * @returns {Promise<string>} e.g. "surrealkv:///path/to/db" or "ws://host:port".
 */
export async function defaultDbUrl() {
  try {
    const cfg = await readConfig();
    if (cfg?.db?.url && typeof cfg.db.url === 'string') {
      return cfg.db.url;
    }
    if (cfg?.db?.engine && typeof cfg.db.engine === 'string') {
      // If a remote scheme leaked into `engine`, treat it as a full URL.
      const e = cfg.db.engine;
      if (/^(wss?|https?):\/\//.test(e)) return e;
      return `${e}://${paths.data.db()}`;
    }
  } catch {
    // No config yet (e.g., during install) — fall through.
  }
  return `${DEFAULT_ENGINE}://${paths.data.db()}`;
}

/**
 * Read SurrealDB sign-in credentials from config.json, if present.
 *
 * Only relevant when `db.url` points at a standalone server (ws://, wss://,
 * http://, https://). Embedded engines don't authenticate.
 *
 * Returns null when no credentials are configured, leaving connect() to
 * skip the signin step.
 *
 * @returns {Promise<{ username: string, password: string } | null>}
 */
async function defaultDbAuth() {
  try {
    const cfg = await readConfig();
    const u = cfg?.db?.user;
    const p = cfg?.db?.pass;
    if (typeof u === 'string' && typeof p === 'string') {
      return { username: u, password: p };
    }
  } catch {
    /* no config yet — skip auth */
  }
  return null;
}

// Connect hangs on `surrealkv+versioned://` in @surrealdb/node 3.0.3.
// A 10s race converts the silent hang into an actionable error so the daemon
// fails fast instead of looking deadlocked.
const CONNECT_TIMEOUT_MS = 10_000;

export async function connect({
  engine = 'mem://',
  namespace = 'robin',
  database = 'main',
  auth,
} = {}) {
  // Register BOTH embedded and remote engines so config can opt into either:
  //   - "surrealkv://", "rocksdb://", "mem://"       — embedded NAPI
  //   - "ws://", "wss://", "http://", "https://"     — standalone server
  // The standalone-server path is the supported way to run Robin with
  // multiple writers (daemon + biographer + CLI). Embedded NAPI is single-
  // writer; concurrent writers hang on the lockfile.
  const db = new Surreal({
    engines: { ...createRemoteEngines(), ...createNodeEngines() },
  });
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `db.connect("${engine}") timed out after ${CONNECT_TIMEOUT_MS}ms. ` +
              `If using "surrealkv+versioned://", this engine variant currently hangs in ` +
              `@surrealdb/node 3.0.3 — switch db.engine to "surrealkv" in config.json.`,
          ),
        ),
      CONNECT_TIMEOUT_MS,
    );
  });
  try {
    await Promise.race([db.connect(engine), timeout]);
  } finally {
    clearTimeout(timer);
  }
  // Remote schemes need sign-in. Caller can pass `auth` explicitly; otherwise
  // we fall back to config.json's db.user/db.pass via defaultDbAuth(). Embedded
  // schemes (mem://, surrealkv://, rocksdb://) don't authenticate.
  const isRemote = /^(wss?|https?):\/\//.test(engine);
  const creds = isRemote ? (auth ?? (await defaultDbAuth())) : null;
  // If signin() or use() throws after connect(), the Surreal handle is still
  // open — close it so NAPI threadsafe handles don't leak (mirrors the
  // NAPI-handle-leak class documented for `node --test` orphan processes).
  try {
    if (creds) await db.signin(creds);
    await db.use({ namespace, database });
  } catch (err) {
    await close(db).catch(() => {});
    throw err;
  }

  // Re-establish session state on every reconnect — two layers of defense
  // against the "Anonymous access not allowed" daemon-wedge bug.
  //
  // The Surreal client (v2.0.3) defaults to enabled reconnect (5 attempts,
  // 1s base + 2x backoff). When the underlying WebSocket reconnects — e.g.
  // after `surreal start` restarts, after laptop sleep, or after a flaky
  // network blip — the new connection comes up *anonymous*, even though
  // signin() and use() were called on the original socket. Without
  // re-applying them, every subsequent scheduler tick fails with
  // "Anonymous access not allowed", and the daemon stays in that broken
  // state until process restart.
  //
  // Layer 1 (proactive): subscribe to the "connected" event and re-apply
  // signin + use. Fast path; covers the common reconnect-then-quiesce case.
  //
  // Layer 2 (reactive): wrap `db.query()` so the returned builder's
  // `.collect()` retries once after `Anonymous access not allowed`. Layer 1
  // alone isn't sufficient — observed 2026-05-14: the `connected` event
  // either didn't fire, or in-flight queries issued in the gap between WS
  // recovery and the event handler running still threw. Layer 2 catches
  // every survivor at the call site.
  //
  // Why wrap `.collect()` rather than `db.query()` itself: surrealdb v2's
  // `query()` returns a synchronous builder (`QueryPromise extends
  // DispatchedPromise`) whose `.collect()` triggers the round-trip. The
  // entire codebase uses `db.query(sql).collect()`; replacing `query` with
  // an async function would resolve the builder eagerly and break the
  // `.collect()` chain.
  installQueryCounter(db);

  if (!isRemote) return db;

  const reauth = singleFlight(async () => {
    log.info({ event: 'db.reauth_triggered' });
    try {
      if (creds) await db.signin(creds);
      await db.use({ namespace, database });
      log.info({ event: 'db.reauth_succeeded' });
    } catch (err) {
      log.warn({
        event: 'db.reauth_failed',
        message: err?.message ?? String(err),
      });
      throw err;
    }
  });

  db.subscribe('connected', () => {
    reauth().catch(() => {
      // reauth() already logged db.reauth_failed; swallow here so the
      // subscriber doesn't crash on a still-broken connection.
    });
  });

  installQueryRetry(db, reauth);
  return db;
}

const ANONYMOUS_MARKER = 'Anonymous access not allowed';

// Active-query counter — tracks `.collect()` calls in flight across all DB
// handles produced by `connect()`. Read by the invariant ctx so weekly
// reauth probes (mcp.daemon_authenticated_after_reconnect) skip when real
// traffic is mid-flight.
//
// Module-scoped (not per-handle): the daemon owns a single primary handle
// at a time; bumping a per-handle counter would require threading the
// handle through ctx-building. Module scope keeps the call sites trivial
// at the cost of "any open handle counts" — acceptable because the only
// non-primary openers are short-lived tests and one-shot CLI commands.
let activeQueryCount = 0;

/**
 * Number of in-flight `db.query(...).collect()` calls across all handles
 * produced by this module's `connect()`. Drives the `activeQueryCount`
 * field on invariant ctx; consult before disturbing live traffic.
 *
 * @returns {number}
 */
export function getActiveQueryCount() {
  return activeQueryCount;
}

/**
 * Wrap `db.query(...)`'s returned builder so its `.collect()` increments
 * the module-scoped `activeQueryCount` before awaiting and decrements in
 * `finally` (success or failure). Installed unconditionally by `connect()`
 * so embedded handles (mem://, surrealkv://, rocksdb://) also report
 * activity — needed for the invariant probe's "skip during workload"
 * gate to work in unit tests and CLI-spawned embedded sessions.
 *
 * On remote handles, `installQueryRetry` runs AFTER this wrapper. Its
 * retry path rebuilds via `boundQuery(...args).collect(...)` — which goes
 * back through this wrapper, so retries are still counted.
 *
 * Mutates `db` in place; returns it.
 *
 * @internal exported for testing.
 */
export function installQueryCounter(db) {
  const origQuery = db.query;
  if (typeof origQuery !== 'function') return db;
  const boundQuery = origQuery.bind(db);
  db.query = function countedQuery(...args) {
    const builder = boundQuery(...args);
    if (!builder || typeof builder.collect !== 'function') return builder;
    const origCollect = builder.collect.bind(builder);
    builder.collect = async (...collectArgs) => {
      activeQueryCount += 1;
      try {
        return await origCollect(...collectArgs);
      } finally {
        activeQueryCount -= 1;
      }
    };
    return builder;
  };
  return db;
}

/**
 * Detect the SurrealDB "Anonymous access not allowed" failure mode. Matches
 * by message substring because the client surfaces it as a `NotAllowedError`
 * in some paths and as a plain `Error` in others.
 *
 * @internal exported for testing.
 */
export function isAnonymousError(err) {
  return String(err?.message ?? err ?? '').includes(ANONYMOUS_MARKER);
}

/**
 * Single-flight wrapper: concurrent callers share the in-flight promise.
 * Prevents reauth stampede when many scheduler ticks fail in the same
 * event-loop turn.
 *
 * @internal exported for testing.
 */
export function singleFlight(fn) {
  let inFlight = null;
  return async () => {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        return await fn();
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };
}

/**
 * Wrap `db.query()` so the returned builder's `.collect()` retries once
 * after `Anonymous access not allowed`. The builder itself is preserved
 * intact — only its `.collect()` method is replaced. Mutates `db` in place
 * and returns it.
 *
 * On retry, we *rebuild* via `db.query(...origArgs)` rather than re-calling
 * `.collect()` on the original builder. `DispatchedPromise` caches its
 * settled state (rejected with Anonymous); a second `.collect()` on it
 * would re-throw the cached error.
 *
 * @internal exported for testing.
 */
export function installQueryRetry(db, reauth) {
  const origQuery = db.query;
  if (typeof origQuery !== 'function') return db;
  const boundQuery = origQuery.bind(db);
  db.query = function patchedQuery(...args) {
    const builder = boundQuery(...args);
    if (!builder || typeof builder.collect !== 'function') return builder;
    const origCollect = builder.collect.bind(builder);
    builder.collect = async (...collectArgs) => {
      try {
        return await origCollect(...collectArgs);
      } catch (err) {
        if (!isAnonymousError(err)) throw err;
        log.warn({
          event: 'db.anonymous_access_observed',
          message: err?.message ?? String(err),
        });
        await reauth();
        return boundQuery(...args).collect(...collectArgs);
      }
    };
    return builder;
  };
  return db;
}

export async function close(db) {
  try {
    await db.close();
  } catch {
    /* idempotent */
  }
}
