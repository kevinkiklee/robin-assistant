import { isPidAlive } from '../../daemon/lock.js';
import { clearDaemonState, readDaemonState } from '../../daemon/state.js';
import { paths } from '../../../config/data-store.js';

export async function mcpStop() {
  const statePath = paths.data.daemonState();
  const state = await readDaemonState(statePath);
  if (!state || !isPidAlive(state.pid)) {
    console.log('daemon not running');
    await clearDaemonState(statePath);
    return;
  }
  process.kill(state.pid, 'SIGTERM');
  for (let i = 0; i < 50; i++) {
    if (!isPidAlive(state.pid)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  console.log('daemon stopped');
}
