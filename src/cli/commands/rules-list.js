import { isPidAlive } from '../../daemon/lock.js';
import { readDaemonState } from '../../daemon/state.js';
import { close, connect } from '../../db/client.js';
import { acquire } from '../../db/lock.js';
import { listRules } from '../../rules/rules.js';
import { ensureHome, paths } from '../../runtime/data-store.js';

export async function rulesList() {
  await ensureHome();
  const daemonState = await readDaemonState(paths.data.daemonState());
  if (daemonState && isPidAlive(daemonState.pid)) {
    console.error('daemon is running. Stop it first: robin mcp stop');
    process.exit(1);
  }
  const release = await acquire(paths.data.daemonLock());
  try {
    const db = await connect({ engine: `rocksdb://${paths.data.db()}` });
    try {
      const list = await listRules(db, { activeOnly: true });
      if (list.length === 0) {
        console.log('no active rules');
        return;
      }
      for (const r of list) {
        console.log(`${String(r.id)}  [priority ${r.priority}]  ${r.content}`);
      }
    } finally {
      await close(db);
    }
  } finally {
    await release();
  }
}
