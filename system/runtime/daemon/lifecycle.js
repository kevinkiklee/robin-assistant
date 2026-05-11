import { clearDaemonState, writeDaemonState } from '../../config/daemon-state.js';
import { createFatalHandler, installFatalHandlers } from './fatal.js';
import { acquireDaemonLock, releaseDaemonLock } from './lock.js';

/**
 * Daemon lifecycle owner.
 *
 * Owns: lock, fatal handlers, state file, signal handlers, graceful
 * shutdown. Subsystems register via `ready({ scheduler, httpServer,
 * integrations, db })`; shutdown stops them in declared order. Idempotent.
 *
 * The fatal-handler 5s force-exit timer (from fatal.js) is independent of
 * shutdown's own 10s grace timer — both are safety nets at different layers.
 */
export function createLifecycle({ lockPath, statePath, logDir } = {}) {
  let acquired = false;
  let subsystems = null;
  let shuttingDown = false;
  let uninstallFatal = null;
  let signalsBound = false;

  async function acquireLock() {
    if (acquired) return;
    await acquireDaemonLock(lockPath);
    acquired = true;
    if (logDir) {
      const handler = createFatalHandler({ logDir, shutdown: () => shutdown('fatal') });
      uninstallFatal = installFatalHandlers(handler);
    }
    if (!signalsBound) {
      process.on('SIGTERM', () => shutdown('SIGTERM').finally(() => process.exit(0)));
      process.on('SIGINT', () => shutdown('SIGINT').finally(() => process.exit(0)));
      signalsBound = true;
    }
  }

  function ready(parts) {
    subsystems = parts;
  }

  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    if (signal) console.log(`daemon: received ${signal}, shutting down`);

    const grace = setTimeout(() => {
      console.warn('daemon: shutdown grace expired, forcing exit');
      process.exit(1);
    }, 10_000);
    grace.unref?.();

    try {
      if (subsystems?.scheduler?.stop) {
        try {
          console.log('scheduler stopping (in-flight dream may continue briefly)');
          subsystems.scheduler.stop();
        } catch (e) {
          console.warn(`scheduler stop failed: ${e.message}`);
        }
      }
      if (subsystems?.integrations?.stop) {
        try {
          await subsystems.integrations.stop();
        } catch (e) {
          console.warn(`integrations stop failed: ${e.message}`);
        }
      }
      if (subsystems?.httpServer?.close) {
        try {
          subsystems.httpServer.close();
        } catch (e) {
          console.warn(`http close failed: ${e.message}`);
        }
      }
      if (subsystems?.db?.close) {
        try {
          await subsystems.db.close();
        } catch (e) {
          console.warn(`db close failed: ${e.message}`);
        }
      }
    } finally {
      if (statePath) await clearDaemonState(statePath).catch(() => {});
      if (acquired && lockPath) await releaseDaemonLock(lockPath).catch(() => {});
      if (uninstallFatal) uninstallFatal();
      clearTimeout(grace);
    }
  }

  async function writeReady({ port, pid, version, startedAt, toolCount }) {
    if (statePath) {
      await writeDaemonState(statePath, {
        port,
        pid,
        version,
        started_at: startedAt,
        tool_count: toolCount,
      });
    }
  }

  function wait() {
    return new Promise(() => {});
  }

  async function fail(err) {
    console.error(`daemon failed: ${err?.message ?? err}`);
    await shutdown('fail');
  }

  return { acquireLock, ready, shutdown, writeReady, wait, fail };
}
