import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { clearDaemonState, readDaemonState } from '../../../config/daemon-state.js';
import { paths } from '../../../config/data-store.js';
import { isPidAlive } from '../../daemon/lock.js';
import { mcpStart } from './mcp-start.js';

// Generous upper bound. The poll exits earlier in two ways: (a) the state
// file appears with a live PID (success), or (b) the spawned PID dies
// before state is written (daemon crashed — fail fast). The cap only
// matters if the daemon stays alive but never writes state, which would
// indicate it's hung.
const STARTUP_TIMEOUT_MS = 60000;
const POLL_INTERVAL_MS = 100;

async function tailDaemonLog(lines = 20) {
  try {
    const logPath = join(paths.data.logs(), 'daemon.log');
    const text = await readFile(logPath, 'utf-8');
    const rows = text.split('\n').filter(Boolean);
    return rows.slice(-lines).join('\n');
  } catch {
    return null;
  }
}

export async function mcpEnsureRunning() {
  const statePath = paths.data.daemonState();
  const state = await readDaemonState(statePath);
  if (state && isPidAlive(state.pid)) {
    console.log(`daemon already running on :${state.port}`);
    return;
  }
  if (state) await clearDaemonState(statePath);

  const spawnedPid = await mcpStart();
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const s = await readDaemonState(statePath);
    if (s && isPidAlive(s.pid)) {
      console.log(`daemon ready on :${s.port}`);
      return;
    }
    if (spawnedPid && !isPidAlive(spawnedPid)) {
      const tail = await tailDaemonLog();
      const tailMsg = tail ? `\nlast log lines:\n${tail}` : '';
      throw new Error(`daemon process (pid ${spawnedPid}) exited before becoming ready${tailMsg}`);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  const tail = await tailDaemonLog();
  const tailMsg = tail ? `\nlast log lines:\n${tail}` : '';
  throw new Error(
    `daemon failed to start within ${Math.round(STARTUP_TIMEOUT_MS / 1000)}s${tailMsg}`,
  );
}
