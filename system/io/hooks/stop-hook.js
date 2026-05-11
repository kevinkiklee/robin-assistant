import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { readDaemonState } from '../../config/daemon-state.js';
import { ensureHome, paths } from '../../config/data-store.js';
import { resolveBinPath } from '../../runtime/cli/bin.js';
import { isPidAlive } from '../../runtime/daemon/lock.js';

async function tryDaemonRoute(state, body, fetchFn) {
  try {
    const url = `http://127.0.0.1:${state.port}/internal/biographer/process-pending`;
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function stopHookHandler(args = {}) {
  const stdin = args.stdin ?? {};
  const since = args.since ?? stdin.since;
  const transcriptPath = stdin.transcript_path ?? stdin.transcriptPath;
  const sessionId = stdin.session_id ?? stdin.sessionId;
  const fetchFn = args.fetchFn ?? fetch;
  const readState = args.readState;

  await ensureHome();
  const state = readState ? await readState() : await readDaemonState(paths.data.daemonState());
  if (state && isPidAlive(state.pid)) {
    const body = {};
    if (since) body.since = since;
    if (transcriptPath) body.transcript_path = transcriptPath;
    if (sessionId) body.session_id = sessionId;
    const ok = await tryDaemonRoute(state, body, fetchFn);
    if (ok) return;
  }
  // Direct-spawn fallback
  const logsDir = paths.data.logs();
  mkdirSync(logsDir, { recursive: true });
  const logFh = await open(join(logsDir, 'biographer.log'), 'a');
  const cmdArgs = [resolveBinPath(), 'biographer', 'process-pending'];
  if (since) cmdArgs.push('--since', since);
  if (transcriptPath) cmdArgs.push('--transcript-path', transcriptPath);
  if (sessionId) cmdArgs.push('--session-id', sessionId);
  const proc = spawn(process.execPath, cmdArgs, {
    detached: true,
    stdio: ['ignore', logFh.fd, logFh.fd],
    env: process.env,
  });
  proc.unref();
  await logFh.close();
}
