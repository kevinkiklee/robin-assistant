import { surql } from 'surrealdb';
import { biographerProcess } from '../../../cognition/biographer/pipeline.js';
import { ensureHome, paths } from '../../../config/data-store.js';
import { close, connect, defaultDbUrl } from '../../../data/db/client.js';
import { acquire } from '../../../data/db/lock.js';
import { createEmbedder } from '../../../data/embed/factory.js';
import { captureFromTranscript } from '../../../io/capture/session-capture.js';
import { detectHost } from '../../hosts/detect.js';
import { parseArgs } from '../args.js';

export async function biographerProcessPending(argv) {
  const args = parseArgs(argv);
  const since = args.flags.since ? new Date(args.flags.since) : null;
  const transcriptPath = args.flags['transcript-path'] ?? null;
  const sessionId = args.flags['session-id'] ?? null;

  await ensureHome();
  const release = await acquire(paths.data.daemonLock());
  try {
    const db = await connect({ engine: await defaultDbUrl() });
    try {
      let embedder = null;
      let host = null;

      // Capture pre-step. Fail-soft: errors do not block biographer.
      // Hoists embedder + host so the biographer loop below reuses them.
      if (transcriptPath) {
        try {
          embedder = await createEmbedder();
          host = await detectHost();
          await captureFromTranscript(db, embedder, {
            transcriptPath,
            sessionId,
            host: host?.name ?? null,
          });
        } catch (e) {
          console.error(`capture pre-step failed: ${e.message}`);
        }
      }

      // Find pending events (avoids loading embedder when there's nothing to do
      // AND the capture pre-step didn't already load one).
      const query = since
        ? surql`SELECT id, ts FROM events WHERE biographed_at IS NONE AND ts >= ${since} ORDER BY ts ASC LIMIT 50`
        : surql`SELECT id, ts FROM events WHERE biographed_at IS NONE ORDER BY ts ASC LIMIT 50`;
      const [pending] = await db.query(query).collect();

      if (pending.length === 0) {
        console.log('process-pending: 0 events');
        return;
      }

      if (!embedder) embedder = await createEmbedder();
      if (!host) host = await detectHost();

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
