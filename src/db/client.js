import { createNodeEngines } from '@surrealdb/node';
import { Surreal } from 'surrealdb';
import { readConfig } from '../runtime/config.js';
import { paths } from '../runtime/data-store.js';

// Default engine; can be overridden via config.json's `db.engine` field.
// surrealkv is the canonical successor to rocksdb on SurrealDB v3.
// NOTE: `surrealkv+versioned` (which unlocks `SELECT ... VERSION d'...'`
// time-travel reads) currently hangs on connect under @surrealdb/node 3.0.3.
// Once that upstream issue is resolved, flip the default by setting
// `db.engine: 'surrealkv+versioned'` in config.json — no schema change needed.
export const DEFAULT_ENGINE = 'surrealkv';

/**
 * Resolve the URL to use for the production embedded DB based on the user's
 * config. Reads `db.engine` from config.json with a `surrealkv` default. Pure
 * path computation; doesn't connect.
 *
 * @returns {Promise<string>} e.g. "surrealkv:///path/to/db"
 */
export async function defaultDbUrl() {
  let engine = DEFAULT_ENGINE;
  try {
    const cfg = await readConfig();
    if (cfg?.db?.engine && typeof cfg.db.engine === 'string') {
      engine = cfg.db.engine;
    }
  } catch {
    // No config yet (e.g., during install) — fall through to the default.
  }
  return `${engine}://${paths.data.db()}`;
}

// Connect hangs on `surrealkv+versioned://` in @surrealdb/node 3.0.3.
// A 10s race converts the silent hang into an actionable error so the daemon
// fails fast instead of looking deadlocked.
const CONNECT_TIMEOUT_MS = 10_000;

export async function connect({ engine = 'mem://', namespace = 'robin', database = 'main' } = {}) {
  const db = new Surreal({ engines: createNodeEngines() });
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
