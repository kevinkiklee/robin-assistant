import { isPidAlive } from '../../daemon/lock.js';
import { readDaemonState } from '../../daemon/state.js';
import { close, connect } from '../../db/client.js';
import { acquire } from '../../db/lock.js';
import { getHotContext } from '../../memory/attention.js';
import { ensureHome, paths } from '../../runtime/data-store.js';

export async function hotCmd() {
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
      const r = await getHotContext(db);
      console.log(JSON.stringify(r, null, 2));
    } finally {
      await close(db);
    }
  } finally {
    await release();
  }
}
