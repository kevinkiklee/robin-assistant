import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Build a fatal-error handler. The returned function logs to a single-line
 * JSON file under `<logDir>/fatal.log`, attempts a best-effort shutdown,
 * then calls exit(1). A hard timer guarantees exit even if shutdown hangs.
 *
 * Designed for injection so tests can stub exit/shutdown.
 */
export function createFatalHandler({
  logDir,
  shutdown,
  exit = (code) => process.exit(code),
  forceExitMs = 5000,
}) {
  return async function onFatal(err) {
    // Guarantee exit no matter what.
    const force = setTimeout(() => exit(1), forceExitMs);
    force.unref?.();

    // Always write to stderr first (cheapest signal).
    try {
      const summary = err?.stack ?? err?.message ?? String(err);
      process.stderr.write(`[fatal] ${summary}\n`);
    } catch {
      /* never throw from a fatal handler */
    }

    // Best-effort log file.
    try {
      await mkdir(logDir, { recursive: true });
      const line = `${JSON.stringify({
        ts: new Date().toISOString(),
        kind: err?.name ?? 'Error',
        message: err?.message ?? String(err),
        stack: err?.stack ?? null,
      })}\n`;
      await appendFile(join(logDir, 'fatal.log'), line);
    } catch {
      /* swallow */
    }

    // Best-effort shutdown.
    try {
      if (typeof shutdown === 'function') await shutdown('fatal');
    } catch {
      /* swallow */
    }

    clearTimeout(force);
    exit(1);
  };
}

/**
 * Install the handler on `process` for both uncaughtException and
 * unhandledRejection. Returns an unregister fn for tests.
 */
export function installFatalHandlers(handler) {
  const onException = (err) => {
    handler(err);
  };
  const onRejection = (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    handler(err);
  };
  process.on('uncaughtException', onException);
  process.on('unhandledRejection', onRejection);
  return () => {
    process.off('uncaughtException', onException);
    process.off('unhandledRejection', onRejection);
  };
}
