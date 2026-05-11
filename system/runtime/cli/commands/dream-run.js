import { dreamProcess } from '../../../cognition/dream/pipeline.js';
import { ensureHome, paths } from '../../../config/data-store.js';
import { close, connect, defaultDbUrl } from '../../../data/db/client.js';
import { acquire } from '../../../data/db/lock.js';
import { createEmbedder } from '../../../data/embed/factory.js';
import { isPidAlive } from '../../daemon/lock.js';
import { readDaemonState } from '../../daemon/state.js';
import { detectHost } from '../../hosts/detect.js';

export async function dreamRun() {
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
      let host;
      try {
        host = await detectHost();
      } catch (e) {
        console.error(`dream run: ${e.message}`);
        process.exit(1);
      }
      const embedder = await createEmbedder();
      const summary = await dreamProcess(db, host, embedder);
      console.log(JSON.stringify(summary, null, 2));
    } finally {
      await close(db);
    }
  } finally {
    await release();
  }
}
