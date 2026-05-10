import { isPidAlive } from '../../daemon/lock.js';
import { readDaemonState } from '../../daemon/state.js';
import { close, connect } from '../../db/client.js';
import { acquire } from '../../db/lock.js';
import { dreamProcess } from '../../dream/pipeline.js';
import { createTransformersEmbedder } from '../../embed/embedder.js';
import { detectHost } from '../../hosts/detect.js';
import { ensureHome, paths } from '../../runtime/home.js';

export async function dreamRun() {
  await ensureHome();
  const p = paths();
  const daemonState = await readDaemonState(p.daemonState);
  if (daemonState && isPidAlive(daemonState.pid)) {
    console.error('daemon is running. Stop it first: robin mcp stop');
    process.exit(1);
  }
  const release = await acquire(p.daemonLock);
  try {
    const db = await connect({ engine: `rocksdb://${p.db}` });
    try {
      let host;
      try {
        host = await detectHost();
      } catch (e) {
        console.error(`dream run: ${e.message}`);
        process.exit(1);
      }
      const embedder = await createTransformersEmbedder();
      const summary = await dreamProcess(db, host, embedder);
      console.log(JSON.stringify(summary, null, 2));
    } finally {
      await close(db);
    }
  } finally {
    await release();
  }
}
