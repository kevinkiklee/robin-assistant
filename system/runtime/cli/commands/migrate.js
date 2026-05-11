import { ensureHome, paths } from '../../../config/data-store.js';
import { snapshot } from '../../../data/db/backup.js';
import { close, connect, defaultDbUrl } from '../../../data/db/client.js';
import { acquire } from '../../../data/db/lock.js';
import { runMigrations } from '../../../data/db/migrate.js';
import { isPidAlive } from '../../daemon/lock.js';
import { readDaemonState } from '../../daemon/state.js';

export async function migrate() {
  await ensureHome();
  const daemonState = await readDaemonState(paths.data.daemonState());
  if (daemonState && isPidAlive(daemonState.pid)) {
    console.error('daemon is running. Stop it first: robin mcp stop');
    process.exit(1);
  }
  const release = await acquire(paths.data.daemonLock());
  try {
    // Pre-migration backup (no-op on fresh install where db dir is empty)
    const archive = await snapshot(paths.data.db(), paths.data.backup());
    if (archive) console.log(`backup: ${archive}`);

    const db = await connect({ engine: await defaultDbUrl() });
    try {
      const applied = await runMigrations(db, paths.source.migrations());
      const suffix = applied.length ? `: ${applied.join(', ')}` : '';
      const noun = applied.length === 1 ? 'migration' : 'migrations';
      console.log(`applied ${applied.length} ${noun}${suffix}`);
    } finally {
      await close(db);
    }
  } finally {
    await release();
  }
}
