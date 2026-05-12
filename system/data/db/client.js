import { createNodeEngines } from '@surrealdb/node';
import { createRemoteEngines, Surreal } from 'surrealdb';
import { paths } from '../../config/data-store.js';
import { readConfig } from '../../config/paths.js';

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
export const DEFAULT_ENGINE = 'surrealkv';

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
export async function defaultDbAuth() {
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
  if (/^(wss?|https?):\/\//.test(engine)) {
    const creds = auth ?? (await defaultDbAuth());
    if (creds) await db.signin(creds);
  }
  await db.use({ namespace, database });
  return db;
}

export async function close(db) {
  try {
    await db.close();
  } catch {
    /* idempotent */
  }
}
