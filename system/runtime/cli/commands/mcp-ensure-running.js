import { clearDaemonState, readDaemonState } from '../../../config/daemon-state.js';
import { paths } from '../../../config/data-store.js';
import { isPidAlive } from '../../daemon/lock.js';
import { mcpStart } from './mcp-start.js';

export async function mcpEnsureRunning() {
  const statePath = paths.data.daemonState();
  const state = await readDaemonState(statePath);
  if (state && isPidAlive(state.pid)) {
    console.log(`daemon already running on :${state.port}`);
    return;
  }
  if (state) await clearDaemonState(statePath);
  await mcpStart();
  for (let i = 0; i < 50; i++) {
    const s = await readDaemonState(statePath);
    if (s && isPidAlive(s.pid)) {
      console.log(`daemon ready on :${s.port}`);
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('daemon failed to start within 5s');
}
