import { readDaemonState } from '../../../config/daemon-state.js';
import { paths } from '../../../config/data-store.js';
import { isPidAlive } from '../../daemon/lock.js';

export async function mcpStatus() {
  const state = await readDaemonState(paths.data.daemonState());
  if (!state) {
    console.log('not running');
    return;
  }
  const alive = isPidAlive(state.pid);
  console.log(
    JSON.stringify(
      {
        running: alive,
        port: state.port,
        pid: state.pid,
        version: state.version,
        started_at: state.started_at,
      },
      null,
      2,
    ),
  );
}
