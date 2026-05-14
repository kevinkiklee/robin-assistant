import { readDaemonState } from '../../../config/daemon-state.js';
import { ensureHome, paths } from '../../../config/data-store.js';
import { close, connect, defaultDbUrl } from '../../../data/db/client.js';
import { acquire } from '../../../data/db/lock.js';
import { createEmbedder } from '../../../data/embed/factory.js';
import { captureFromTranscript } from '../../../io/capture/session-capture.js';
import { isPidAlive } from '../../daemon/lock.js';
import { detectHost } from '../../hosts/detect.js';
import { parseArgs } from '../args.js';
import { delegateToDaemon, processPendingChunks } from './_biographer-shared.js';

export async function biographerProcessPending(argv) {
  const args = parseArgs(argv);
  const since = args.flags.since ? new Date(args.flags.since) : null;
  const transcriptPath = args.flags['transcript-path'] ?? null;
  const sessionId = args.flags['session-id'] ?? null;

  await ensureHome();

  // Daemon delegation. The route handles the capture pre-step itself when
  // transcript_path is in the body, so forward all of it.
  const state = await readDaemonState(paths.data.daemonState());
  if (state && isPidAlive(state.pid)) {
    const body = {};
    if (since) body.since = since.toISOString();
    if (transcriptPath) body.transcript_path = transcriptPath;
    if (sessionId) body.session_id = sessionId;
    const result = await delegateToDaemon(state, body);
    if (result) {
      const n = typeof result.enqueued === 'number' ? result.enqueued : 0;
      console.log(`process-pending: ${n} events (delegated to daemon)`);
      return;
    }
    // Fall through to CLI path on delegation failure.
  }

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
          embedder = await createEmbedder({ db });
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
      const { listPendingEvents } = await import('../../../cognition/biographer/pending-events.js');
      const pending = await listPendingEvents(db, { since, limit: 50 });

      if (pending.length === 0) {
        console.log('process-pending: 0 events');
        return;
      }

      if (!embedder) embedder = await createEmbedder({ db });
      if (!host) host = await detectHost();

      const { ok, failed } = await processPendingChunks(db, embedder, host, pending);
      console.log(`process-pending: ${ok} events${failed ? ` (${failed} failed)` : ''}`);
    } finally {
      await close(db);
    }
  } finally {
    await release();
  }
}
