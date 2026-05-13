import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { ensureHome, paths } from '../../../config/data-store.js';

/**
 * Start the daemon.
 *
 * Two modes:
 *  - **Default (detached):** spawn `node server.js` detached, log to
 *    `<home>/runtime/logs/daemon.log`, return immediately. This is the
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
 *
 * EALREADY handling: when another daemon already owns the lock,
 * `--foreground` mode attaches to that daemon's pid instead of exiting
 * non-zero. Otherwise launchd's KeepAlive=true would re-spawn this
 * supervisor in a tight loop, generating "daemon already running" log
 * spam every few seconds (observed in production after the daemon was
 * started outside the supervisor path).
 */
export async function mcpStart(argv = []) {
  await ensureHome();
  if (argv.includes('--foreground')) {
    const { startDaemon } = await import('../../daemon/server.js');
    try {
      await startDaemon();
      return;
    } catch (err) {
      if (err?.code === 'EALREADY') {
        const match = /pid (\d+)/.exec(err.message ?? '');
        const pid = match ? Number.parseInt(match[1], 10) : null;
        if (!pid) throw err;
        const { isPidAlive } = await import('../../daemon/lock.js');
        console.log(`daemon already running (pid ${pid}); attaching to its lifetime`);
        while (isPidAlive(pid)) {
          await wait(5000);
        }
        console.log(`daemon pid ${pid} exited; supervisor returning for launchd restart`);
        return;
      }
      throw err;
    }
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
