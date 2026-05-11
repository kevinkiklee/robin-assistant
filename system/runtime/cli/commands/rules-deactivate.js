import { deactivateRule } from '../../../cognition/memory/rules.js';
import { readDaemonState } from '../../../config/daemon-state.js';
import { ensureHome, paths } from '../../../config/data-store.js';
import { close, connect, defaultDbUrl } from '../../../data/db/client.js';
import { acquire } from '../../../data/db/lock.js';
import { isPidAlive } from '../../daemon/lock.js';

export async function rulesDeactivate(argv) {
  if (!argv[0]) {
    console.error('usage: robin rules deactivate <id>');
    process.exit(1);
  }
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
      await deactivateRule(db, argv[0]);
      console.log('deactivated');
    } finally {
      await close(db);
    }
  } finally {
    await release();
  }
}
