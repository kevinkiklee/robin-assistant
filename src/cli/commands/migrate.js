import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isPidAlive } from '../../daemon/lock.js';
import { readDaemonState } from '../../daemon/state.js';
import { snapshot } from '../../db/backup.js';
import { close, connect } from '../../db/client.js';
import { acquire } from '../../db/lock.js';
import { runMigrations } from '../../db/migrate.js';
import { ensureHome, paths } from '../../runtime/home.js';

export async function migrate() {
  await ensureHome();
  const p = paths();
  const daemonState = await readDaemonState(join(p.home, '.daemon.state'));
  if (daemonState && isPidAlive(daemonState.pid)) {
    console.error('daemon is running. Stop it first: robin mcp stop');
    process.exit(1);
  }
  const release = await acquire(p.lock);
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const migrationsDir = resolve(here, '../../schema/migrations');

    // Pre-migration backup (no-op on fresh install where db dir is empty)
    const archive = await snapshot(p.db, p.backup);
    if (archive) console.log(`backup: ${archive}`);

    const db = await connect({ engine: `rocksdb://${p.db}` });
    try {
      const applied = await runMigrations(db, migrationsDir);
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
