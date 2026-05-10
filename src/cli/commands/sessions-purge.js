// `robin sessions [--stale]` CLI command.
//
// Without flags: lists active sessions as a table.
// With --stale: deletes rows whose status is 'stale' and prints the count.
//
// Connects directly to the rocksdb file using the daemon-lock pattern (same
// as journal/hot CLI commands): refuses to run while the daemon is up so
// that we don't stomp on its DB handle.

import { isPidAlive } from '../../daemon/lock.js';
import { listActiveSessions, purgeStaleSessions } from '../../daemon/sessions.js';
import { readDaemonState } from '../../daemon/state.js';
import { close, connect } from '../../db/client.js';
import { acquire } from '../../db/lock.js';
import { ensureHome, paths } from '../../runtime/home.js';
import { parseArgs } from '../args.js';

function formatTs(v) {
  if (!v) return '—';
  if (v instanceof Date) return v.toISOString();
  try {
    return new Date(v).toISOString();
  } catch {
    return String(v);
  }
}

export async function sessionsPurge(argv) {
  const args = parseArgs(argv);
  const stale = args.flags.stale === true;

  await ensureHome();
  const p = paths();
  const daemonState = await readDaemonState(p.daemonState);
  if (daemonState && isPidAlive(daemonState.pid)) {
    console.error('daemon is running. Stop it first: robin mcp stop');
    process.exit(1);
  }
  const release = await acquire(p.daemonLock);
  try {
    const db = await connect({ engine: `rocksdb://${p.db}` });
    try {
      if (stale) {
        const n = await purgeStaleSessions(db);
        console.log(`purged ${n} stale sessions`);
        return;
      }
      const rows = await listActiveSessions(db);
      if (rows.length === 0) {
        console.log('(no active sessions)');
        return;
      }
      console.log(
        `${'session_id'.padEnd(36)}  ${'host'.padEnd(11)}  ${'pid'.padEnd(7)}  ${'started_at'.padEnd(25)}  last_seen_at`,
      );
      for (const r of rows) {
        const sid = String(r.session_id ?? '?').padEnd(36);
        const host = String(r.host ?? '?').padEnd(11);
        const pid = String(r.pid ?? '—').padEnd(7);
        const start = formatTs(r.started_at).padEnd(25);
        const last = formatTs(r.last_seen_at);
        console.log(`${sid}  ${host}  ${pid}  ${start}  ${last}`);
      }
    } finally {
      await close(db);
    }
  } finally {
    await release();
  }
}
