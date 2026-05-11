import { isPidAlive } from '../../daemon/lock.js';
import { readDaemonState } from '../../daemon/state.js';
import { close, connect } from '../../db/client.js';
import { acquire } from '../../db/lock.js';
import { getHotContext } from '../../memory/hot.js';
import { ensureHome, paths } from '../../runtime/data-store.js';

export async function hotCmd() {
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
      const r = await getHotContext(db);
      console.log(JSON.stringify(r, null, 2));
    } finally {
      await close(db);
    }
  } finally {
    await release();
  }
}
