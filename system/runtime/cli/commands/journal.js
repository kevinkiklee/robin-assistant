import { listJournalEntries } from '../../../cognition/memory/chronicle.js';
import { readDaemonState } from '../../../config/daemon-state.js';
import { ensureHome, paths } from '../../../config/data-store.js';
import { close, connect, defaultDbUrl } from '../../../data/db/client.js';
import { acquire } from '../../../data/db/lock.js';
import { isPidAlive } from '../../daemon/lock.js';
import { parseArgs } from '../args.js';

export async function journalCmd(argv) {
  const args = parseArgs(argv);
  const limitFlag = args.flags.limit;
  const limit = limitFlag ? Number.parseInt(limitFlag, 10) : 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    console.error(`journal: --limit must be int in [1,1000]; got ${limitFlag}`);
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
      const entries = await listJournalEntries(db, {
        since: typeof args.flags.since === 'string' ? args.flags.since : undefined,
        until: typeof args.flags.until === 'string' ? args.flags.until : undefined,
        limit,
      });
      if (entries.length === 0) {
        console.log('(empty)');
        return;
      }
      for (const e of entries) {
        const ts = e.ts instanceof Date ? e.ts.toISOString() : new Date(e.ts).toISOString();
        console.log(`[${ts}] [${e.source}] ${e.content}`);
      }
    } finally {
      await close(db);
    }
  } finally {
    await release();
  }
}
