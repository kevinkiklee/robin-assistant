import { surql } from 'surrealdb';
import { readDaemonState } from '../../../config/daemon-state.js';
import { ensureHome, paths } from '../../../config/data-store.js';
import { close, connect, defaultDbUrl } from '../../../data/db/client.js';
import { acquire } from '../../../data/db/lock.js';
import { createEmbedder } from '../../../data/embed/factory.js';
import { isPidAlive } from '../../daemon/lock.js';
import { detectHost } from '../../hosts/detect.js';
import { parseArgs } from '../args.js';
import { delegateToDaemon, processPendingChunks } from './_biographer-shared.js';

export async function biographerCatchup(argv) {
  const args = parseArgs(argv);
  const retryFailed = args.flags['retry-failed'] === true;

  await ensureHome();

  // --retry-failed reads from runtime:biographer.failed_event_ids which the
  // daemon's accumulator/worker doesn't traverse, so for that flag we always
  // run the CLI pipeline. Otherwise prefer daemon delegation.
  if (!retryFailed) {
    const state = await readDaemonState(paths.data.daemonState());
    if (state && isPidAlive(state.pid)) {
      const result = await delegateToDaemon(state, {});
      if (result) {
        const n = typeof result.enqueued === 'number' ? result.enqueued : 0;
        console.log(`processed ${n} events (delegated to daemon)`);
        return;
      }
      // Fall through to CLI path on delegation failure so a flaky daemon
      // doesn't block the cron.
    }
  }

  const release = await acquire(paths.data.daemonLock());
  try {
    const db = await connect({ engine: await defaultDbUrl() });
    try {
      let pending;
      if (retryFailed) {
        const [rt] = await db
          .query(surql`SELECT * FROM type::record('runtime', 'biographer') LIMIT 1`)
          .collect();
        const ids = rt[0]?.value?.failed_event_ids ?? [];
        if (ids.length === 0) {
          console.log('processed 0 events (nothing to retry)');
          return;
        }
        const [rows] = await db
          .query(surql`SELECT id, source FROM events WHERE id IN ${ids}`)
          .collect();
        pending = rows;
      } else {
        const { listPendingEvents } = await import(
          '../../../cognition/biographer/pending-events.js'
        );
        pending = await listPendingEvents(db, { limit: 100 });
      }

      if (pending.length === 0) {
        console.log('processed 0 events');
        return;
      }

      // Lazy: only build embedder + host when we actually have work to do.
      const embedder = await createEmbedder({ db });
      const host = await detectHost();
      const { ok, failed } = await processPendingChunks(db, embedder, host, pending);
      console.log(`processed ${ok} events${failed ? ` (${failed} failed)` : ''}`);
    } finally {
      await close(db);
    }
  } finally {
    await release();
  }
}
