import { spawn } from 'node:child_process';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { isPidAlive } from '../daemon/lock.js';
import { readDaemonState } from '../daemon/state.js';
import { resolveBinPath } from '../runtime/bin.js';
import { ensureHome, paths } from '../runtime/home.js';

async function tryDaemonRoute(state, since) {
  try {
    const url = `http://127.0.0.1:${state.port}/internal/biographer/process-pending`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ since }),
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function stopHookHandler({ since } = {}) {
  await ensureHome();
  const p = paths();
  const state = await readDaemonState(join(p.home, '.daemon.state'));
  if (state && isPidAlive(state.pid)) {
    const ok = await tryDaemonRoute(state, since);
    if (ok) return;
  }
  // Fallback: spawn-detached subprocess
  const logFh = await open(join(p.logs, 'biographer.log'), 'a');
  const args = [resolveBinPath(), 'biographer', 'process-pending'];
  if (since) args.push('--since', since);
  const proc = spawn(process.execPath, args, {
    detached: true,
    stdio: ['ignore', logFh.fd, logFh.fd],
    env: process.env,
  });
  proc.unref();
  await logFh.close();
}
