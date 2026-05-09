import { spawn } from 'node:child_process';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveBinPath } from '../runtime/bin.js';
import { ensureHome, paths } from '../runtime/home.js';

export async function stopHookHandler({ since } = {}) {
  await ensureHome();
  const p = paths();
  const logFh = await open(join(p.logs, 'biographer.log'), 'a');
  try {
    const args = [resolveBinPath(), 'biographer', 'process-pending'];
    if (since) {
      args.push('--since', since);
    }
    const proc = spawn(process.execPath, args, {
      detached: true,
      stdio: ['ignore', logFh.fd, logFh.fd],
      env: process.env,
    });
    proc.unref();
  } finally {
    await logFh.close();
  }
}
