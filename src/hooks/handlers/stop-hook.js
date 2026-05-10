import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { isPidAlive } from '../../daemon/lock.js';
import { readDaemonState } from '../../daemon/state.js';
import { resolveBinPath } from '../../runtime/bin.js';
import { ensureHome, paths } from '../../runtime/home.js';

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

// Dispatcher contract: called as `stopHookHandler({stdin})` from src/hooks/cli.js.
// Direct callers (CLI biographer-process-pending, integration tests) pass {since}.
// Both shapes accepted: prefer explicit `since`, else read from stdin payload
// (Claude Code Stop hook does not include `since` natively — fallback is undefined).
export async function stopHookHandler(args = {}) {
  const since = args.since ?? args.stdin?.since;
  await ensureHome();
  const p = paths();
  const state = await readDaemonState(p.daemonState);
  if (state && isPidAlive(state.pid)) {
    const ok = await tryDaemonRoute(state, since);
    if (ok) return;
  }
  const logsDir = join(p.cache, 'logs');
  mkdirSync(logsDir, { recursive: true });
  const logFh = await open(join(logsDir, 'biographer.log'), 'a');
  const cmdArgs = [resolveBinPath(), 'biographer', 'process-pending'];
  if (since) cmdArgs.push('--since', since);
  const proc = spawn(process.execPath, cmdArgs, {
    detached: true,
    stdio: ['ignore', logFh.fd, logFh.fd],
    env: process.env,
  });
  proc.unref();
  await logFh.close();
}
