import { createNodeEngines } from '@surrealdb/node';
import { createRemoteEngines, Surreal } from 'surrealdb';
import { readConfig } from '../runtime/config.js';
import { paths } from '../runtime/data-store.js';

// Default engine; can be overridden via config.json's `db.engine` field.
// surrealkv is the canonical successor to rocksdb on SurrealDB v3.
//
// Embedded engines: `mem`, `rocksdb`, `surrealkv`, `surrealkv+versioned`.
// NOTE: `surrealkv+versioned://` (embedded) currently hangs on connect under
// @surrealdb/node 3.0.3. As a workaround, point `db.engine` at a remote
// SurrealDB server URL using `ws://` or `wss://`:
//
//   1. Install the standalone server: `brew install surrealdb/tap/surreal` or
//      `curl -sSf https://install.surrealdb.com | sh`.
//   2. Start it with versioned storage:
//      `surreal start --user root --pass root surrealkv+versioned:/path/to/db`
//   3. Set `db.engine: 'ws://127.0.0.1:8000'` in config.json (or set
//      `db.url` directly — the resolver honors both).
//
// scripts/start-surreal-server.mjs automates the spawn + config wiring.
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

// Connect hangs on `surrealkv+versioned://` in @surrealdb/node 3.0.3.
// A 10s race converts the silent hang into an actionable error so the daemon
// fails fast instead of looking deadlocked.
const CONNECT_TIMEOUT_MS = 10_000;

export async function connect({ engine = 'mem://', namespace = 'robin', database = 'main' } = {}) {
  // Register BOTH embedded and remote engines so config can opt into either:
  //   - "surrealkv://", "rocksdb://", "mem://"       — embedded NAPI
  //   - "ws://", "wss://", "http://", "https://"     — standalone server
  // This is the workaround for the surrealkv+versioned embedded-engine hang:
  // run a standalone `surreal start ... surrealkv+versioned:/path` server and
  // connect via ws://.
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
