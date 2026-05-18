import { surql } from 'surrealdb';
import { readDaemonState } from '../../../config/daemon-state.js';
import { ensureHome, paths } from '../../../config/data-store.js';
import { close, connect, defaultDbUrl } from '../../../data/db/client.js';
import { acquire } from '../../../data/db/lock.js';
import { isPidAlive } from '../../daemon/lock.js';

const HEADER = 'created_at | direction | destination | reason | hash';

// `robin refusals list` — recent rows from the refusals table (both inbound
// discretion refusals and outbound write refusals). Plain text columns.
// --policy=<name>  filter to rows whose reason starts with '<name>:'
//                  e.g. --policy=durable-write shows only durable-write gate refusals
export async function refusalsList(argv, { out = console.log, err = console.error } = {}) {
  await ensureHome();
  const daemonState = await readDaemonState(paths.data.daemonState());
  if (daemonState && isPidAlive(daemonState.pid)) {
    err('daemon is running. Stop it first: robin mcp stop');
    process.exit(1);
  }
  const release = await acquire(paths.data.daemonLock());
  try {
    const db = await connect({ engine: await defaultDbUrl() });
    try {
      const policy = argv?.policy ?? argv?.p ?? null;
      await printRefusals(db, out, { policy });
    } finally {
      await close(db);
    }
  } finally {
    await release();
  }
}

// Exported for direct test use against an in-memory db; mirrors the
// daemon-aware command body without the home/lock plumbing.
// Schema moved destination/payload_hash into `meta`; project them via aliases.
// options.policy — if set, filters rows where reason starts with '<policy>:'
export async function printRefusals(db, out = console.log, { policy } = {}) {
  const whereClause = policy ? surql`WHERE string::starts_with(reason, ${`${policy}:`})` : surql``;
  const [rows] = await db
    .query(
      surql`SELECT created_at, direction, meta.destination AS destination,
                   reason, meta.payload_hash AS payload_hash
              FROM refusals ${whereClause} ORDER BY created_at DESC LIMIT 20`,
    )
    .collect();
  if (!rows || rows.length === 0) {
    out('(no refusals)');
    return;
  }
  out(HEADER);
  for (const r of rows) {
    const ts = r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at);
    out(`${ts} | ${r.direction} | ${r.destination ?? ''} | ${r.reason} | ${r.payload_hash ?? ''}`);
  }
}
