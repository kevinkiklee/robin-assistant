import { spawn } from 'node:child_process';
import { open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureHome, paths } from '../../runtime/home.js';

export async function mcpStart() {
  await ensureHome();
  const p = paths();
  const here = dirname(fileURLToPath(import.meta.url));
  const serverPath = join(here, '../../daemon/server.js');
  const logFh = await open(join(p.logs, 'daemon.log'), 'a');
  const proc = spawn(process.execPath, [serverPath], {
    detached: true,
    stdio: ['ignore', logFh.fd, logFh.fd],
    env: process.env,
  });
  proc.unref();
  await logFh.close();
  console.log(`daemon spawning (pid ${proc.pid}); logs at ${p.logs}/daemon.log`);
}
