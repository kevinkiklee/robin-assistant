import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureHome, paths } from '../../../config/data-store.js';

/**
 * Start the daemon.
 *
 * Two modes:
 *  - **Default (detached):** spawn `node server.js` detached, log to
 *    `<home>/cache/logs/daemon.log`, return immediately. This is the
 *    interactive CLI path (`robin mcp start` from a terminal).
 *  - **`--foreground`:** import and `await startDaemon()` in *this*
 *    process. The function only returns when the daemon shuts down (a
 *    received SIGTERM/SIGINT triggers `process.exit`). This is the
 *    supervisor path: launchd/systemd start the daemon by running
 *    `robin mcp start --foreground`, and their `KeepAlive`/`Restart=always`
 *    semantics then actually track the daemon's lifetime. The previous
 *    default-detached behavior had launchd watching a wrapper that
 *    detached its grandchild and exited in ~50ms — making "restart on
 *    crash" a promise the supervisor couldn't keep.
 */
export async function mcpStart(argv = []) {
  await ensureHome();
  if (argv.includes('--foreground')) {
    // Run in-process so the supervisor's lifetime tracking actually
    // reflects daemon lifetime. startDaemon blocks until the process
    // exits via a signal handler.
    const { startDaemon } = await import('../../daemon/server.js');
    await startDaemon();
    return;
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const serverPath = join(here, '../../daemon/server.js');
  const logsDir = paths.data.logs();
  mkdirSync(logsDir, { recursive: true });
  const logFh = await open(join(logsDir, 'daemon.log'), 'a');
  const proc = spawn(process.execPath, [serverPath], {
    detached: true,
    stdio: ['ignore', logFh.fd, logFh.fd],
    env: process.env,
  });
  proc.unref();
  await logFh.close();
  console.log(`daemon spawning (pid ${proc.pid}); logs at ${logsDir}/daemon.log`);
  return proc.pid;
}
