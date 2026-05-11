import { listRules } from '../../../cognition/memory/rules.js';
import { readDaemonState } from '../../../config/daemon-state.js';
import { ensureHome, paths } from '../../../config/data-store.js';
import { close, connect, defaultDbUrl } from '../../../data/db/client.js';
import { acquire } from '../../../data/db/lock.js';
import { isPidAlive } from '../../daemon/lock.js';

export async function rulesList() {
  await ensureHome();
  const daemonState = await readDaemonState(paths.data.daemonState());
  if (daemonState && isPidAlive(daemonState.pid)) {
    console.error('daemon is running. Stop it first: robin mcp stop');
    process.exit(1);
  }
  const release = await acquire(paths.data.daemonLock());
  try {
    const db = await connect({ engine: await defaultDbUrl() });
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
