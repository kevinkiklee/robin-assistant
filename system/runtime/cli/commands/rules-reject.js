import { rejectCandidate } from '../../../cognition/memory/rules.js';
import { ensureHome, paths } from '../../../config/data-store.js';
import { close, connect, defaultDbUrl } from '../../../data/db/client.js';
import { acquire } from '../../../data/db/lock.js';
import { isPidAlive } from '../../daemon/lock.js';
import { readDaemonState } from '../../daemon/state.js';

export async function rulesReject(argv) {
  if (!argv[0]) {
    console.error('usage: robin rules reject <id> [reason]');
    process.exit(1);
  }
  const id = argv[0];
  const reason = argv.slice(1).join(' ') || undefined;
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
      await rejectCandidate(db, id, reason);
      console.log('rejected');
    } finally {
      await close(db);
    }
  } finally {
    await release();
  }
}
