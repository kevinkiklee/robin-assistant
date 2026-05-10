import { isPidAlive } from '../../daemon/lock.js';
import { clearDaemonState, readDaemonState } from '../../daemon/state.js';
import { paths } from '../../runtime/home.js';

export async function mcpStop() {
  const p = paths();
  const statePath = p.daemonState;
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
