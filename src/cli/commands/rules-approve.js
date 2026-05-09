import { join } from 'node:path';
import { isPidAlive } from '../../daemon/lock.js';
import { readDaemonState } from '../../daemon/state.js';
import { close, connect } from '../../db/client.js';
import { acquire } from '../../db/lock.js';
import { approveCandidate } from '../../rules/rules.js';
import { ensureHome, paths } from '../../runtime/home.js';

export async function rulesApprove(argv) {
  if (!argv[0]) {
    console.error('usage: robin rules approve <id>');
    process.exit(1);
  }
  await ensureHome();
  const p = paths();
  const daemonState = await readDaemonState(join(p.home, '.daemon.state'));
  if (daemonState && isPidAlive(daemonState.pid)) {
    console.error('daemon is running. Stop it first: robin mcp stop');
    process.exit(1);
  }
  const release = await acquire(p.lock);
  try {
    const db = await connect({ engine: `rocksdb://${p.db}` });
    try {
      const r = await approveCandidate(db, argv[0]);
      console.log(`approved; rule id: ${String(r.id)}`);
    } finally {
      await close(db);
    }
  } finally {
    await release();
  }
}
