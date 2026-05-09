import { surql } from 'surrealdb';
import { biographerProcess } from '../../capture/biographer.js';
import { close, connect } from '../../db/client.js';
import { acquire } from '../../db/lock.js';
import { createTransformersEmbedder } from '../../embed/embedder.js';
import { detectHost } from '../../hosts/detect.js';
import { ensureHome, paths } from '../../runtime/home.js';
import { parseArgs } from '../args.js';

export async function biographerProcessPending(argv) {
  const args = parseArgs(argv);
  const since = args.flags.since ? new Date(args.flags.since) : null;

  await ensureHome();
  const p = paths();
  const release = await acquire(p.lock);
  try {
    const db = await connect({ engine: `rocksdb://${p.db}` });
    try {
      // Find pending events first (avoids loading embedder when there's nothing to do)
      const query = since
        ? surql`SELECT id, ts FROM events WHERE biographed_at IS NONE AND ts >= ${since} ORDER BY ts ASC LIMIT 50`
        : surql`SELECT id, ts FROM events WHERE biographed_at IS NONE ORDER BY ts ASC LIMIT 50`;
      const [pending] = await db.query(query).collect();

      if (pending.length === 0) {
        console.log('process-pending: 0 events');
        return;
      }

      const embedder = await createTransformersEmbedder();
      const host = await detectHost();

      let ok = 0;
      let failed = 0;
      for (const row of pending) {
        try {
          await biographerProcess(db, embedder, host, row.id);
          ok++;
        } catch (e) {
          failed++;
          console.error(`biographer failed on ${row.id}: ${e.message}`);
        }
      }
      console.log(`process-pending: ${ok} events${failed ? ` (${failed} failed)` : ''}`);
    } finally {
      await close(db);
    }
  } finally {
    await release();
  }
}
