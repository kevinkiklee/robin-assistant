import { isPidAlive } from '../../daemon/lock.js';
import { readDaemonState } from '../../daemon/state.js';
import { close, connect } from '../../db/client.js';
import { acquire } from '../../db/lock.js';
import { listCandidates } from '../../rules/candidates.js';
import { ensureHome, paths } from '../../runtime/data-store.js';

export async function rulesPending() {
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
      const list = await listCandidates(db, { status: 'pending' });
      if (list.length === 0) {
        console.log('no pending candidates');
        return;
      }
      for (const c of list) {
        console.log(`${String(c.id)}  [${c.kind}]  ${c.content}  (confidence ${c.confidence})`);
      }
    } finally {
      await close(db);
    }
  } finally {
    await release();
  }
}
