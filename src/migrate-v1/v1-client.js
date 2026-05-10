import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { close, connect } from '../db/client.js';

/**
 * Open v1's embedded RocksDB. Read-only by convention — callers never issue
 * writes through this handle.
 *
 * Accepts either a v1 package root (we'll append `user-data/runtime/db/data`
 * if that subpath exists) or a data directory directly.
 */
export async function openV1(packageRoot) {
  const candidate = join(packageRoot, 'user-data/runtime/db/data');
  const dataDir = existsSync(candidate) ? candidate : packageRoot;

  if (!existsSync(dataDir)) {
    throw new Error(`v1 data dir not found: ${dataDir}`);
  }

  let db;
  try {
    db = await connect({ engine: `rocksdb://${dataDir}` });
  } catch (e) {
    if (/lock|LOCK|locked|busy/i.test(String(e?.message))) {
      throw new Error(
        `v1 appears to still be running — stop it first (rocksdb lock at ${dataDir})`,
      );
    }
    throw e;
  }

  await db.use({ namespace: 'robin', database: 'main' });

  return {
    raw: db,
    query: (sql, ...args) => db.query(sql, ...args),
    close: async () => {
      await close(db);
    },
  };
}

/** Row count for a v1 table. Returns 0 for missing/empty tables. */
export async function listTableCount(v1, table) {
  const safe = String(table).replace(/[^a-z_0-9]/gi, '');
  try {
    const [rows] = await v1.query(`SELECT count() AS n FROM ${safe} GROUP ALL`).collect();
    return rows?.[0]?.n ?? 0;
  } catch {
    return 0;
  }
}

/** Yield batches of v1 rows in id order. Terminates on empty/partial last batch. */
export async function* scanTable(v1, table, { batch = 200, startAfter = null } = {}) {
  const safe = String(table).replace(/[^a-z_0-9]/gi, '');
  let cursor = startAfter;

  for (;;) {
    const sql =
      cursor === null
        ? `SELECT * FROM ${safe} ORDER BY id LIMIT ${Number(batch)}`
        : `SELECT * FROM ${safe} WHERE id > ${cursor} ORDER BY id LIMIT ${Number(batch)}`;
    const [rows] = await v1.query(sql).collect();
    if (!rows || rows.length === 0) return;
    yield rows;
    cursor = rows[rows.length - 1].id;
    if (rows.length < batch) return;
  }
}
