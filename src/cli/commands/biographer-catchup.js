import { surql } from 'surrealdb';
import { biographerProcess } from '../../capture/biographer.js';
import { close, connect } from '../../db/client.js';
import { acquire } from '../../db/lock.js';
import { createEmbedder } from '../../embed/factory.js';
import { detectHost } from '../../hosts/detect.js';
import { ensureHome, paths } from '../../runtime/data-store.js';
import { parseArgs } from '../args.js';

export async function biographerCatchup(argv) {
  const args = parseArgs(argv);
  const retryFailed = args.flags['retry-failed'] === true;

  await ensureHome();
  const release = await acquire(paths.data.daemonLock());
  try {
    const db = await connect({ engine: `rocksdb://${paths.data.db()}` });
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
        const [rows] = await db.query(surql`SELECT id FROM events WHERE id IN ${ids}`).collect();
        pending = rows;
      } else {
        const [rows] = await db
          .query(
            surql`SELECT id, ts FROM events WHERE biographed_at IS NONE ORDER BY ts ASC LIMIT 100`,
          )
          .collect();
        pending = rows;
      }

      if (pending.length === 0) {
        console.log('processed 0 events');
        return;
      }

      // Lazy: only build embedder + host when we actually have work to do.
      const embedder = await createEmbedder();
      const host = await detectHost();

      let ok = 0;
      let failed = 0;
      for (const row of pending) {
        try {
          await biographerProcess(db, embedder, host, row.id);
          ok++;
        } catch (e) {
          failed++;
          console.error(`failed: ${row.id}: ${e.message}`);
        }
      }
      console.log(`processed ${ok} events${failed ? ` (${failed} failed)` : ''}`);
    } finally {
      await close(db);
    }
  } finally {
    await release();
  }
}
