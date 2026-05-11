import { surql } from 'surrealdb';
import { isPidAlive } from '../../daemon/lock.js';
import { readDaemonState } from '../../daemon/state.js';
import { close, connect } from '../../db/client.js';
import { acquire } from '../../db/lock.js';
import { ensureHome, paths } from '../../runtime/data-store.js';

const HEADER = 'created_at | direction | destination | reason | hash';

// `robin refusals list` — recent rows from outbound_refusals (both inbound
// PII-guard refusals and outbound write refusals). Plain text columns.
export async function refusalsList(_argv, { out = console.log, err = console.error } = {}) {
  await ensureHome();
  const p = paths();
  const daemonState = await readDaemonState(p.daemonState);
  if (daemonState && isPidAlive(daemonState.pid)) {
    err('daemon is running. Stop it first: robin mcp stop');
    process.exit(1);
  }
  const release = await acquire(p.daemonLock);
  try {
    const db = await connect({ engine: `rocksdb://${p.db}` });
    try {
      await printRefusals(db, out);
    } finally {
      await close(db);
    }
  } finally {
    await release();
  }
}

// Exported for direct test use against an in-memory db; mirrors the
// daemon-aware command body without the home/lock plumbing.
export async function printRefusals(db, out = console.log) {
  const [rows] = await db
    .query(
      surql`SELECT created_at, direction, destination, reason, payload_hash
              FROM outbound_refusals ORDER BY created_at DESC LIMIT 20`,
    )
    .collect();
  if (!rows || rows.length === 0) {
    out('(no refusals)');
    return;
  }
  out(HEADER);
  for (const r of rows) {
    const ts = r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at);
    out(`${ts} | ${r.direction} | ${r.destination} | ${r.reason} | ${r.payload_hash}`);
  }
}
