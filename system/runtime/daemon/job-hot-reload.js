// job-hot-reload.js — restart daemon when user-data job/integration .js changes.
//
// Why this exists: Node's ESM cache pins imported modules for the daemon's
// lifetime. Editing user-data/jobs/**/*.js or user-data/io/**/*.js takes
// effect only after a daemon restart, which made the daily-briefing render
// silently emit pre-edit chrome (the schema_version=2 regression on 2026-05-16).
//
// Strategy: fs.watch the relevant dirs recursively, debounce, then SIGTERM
// self. launchctl (or whichever supervisor) respawns with a fresh module
// graph. Lifecycle's graceful shutdown awaits scheduler drain, so any
// in-flight job completes before exit.
//
// .md files are NOT watched — the dispatcher tick re-reads them every minute
// via ctx.jobs.refresh(), so they don't need a daemon bounce.

import { watch } from 'node:fs';

const DEFAULT_DEBOUNCE_MS = 2_000;

/**
 * Start a hot-reload watcher. Returns `{ stop }`.
 *
 * @param {{
 *   paths: string[],            // directories to watch recursively
 *   debounceMs?: number,        // coalesce rapid edits (default 2s)
 *   signalSelf?: () => void,    // injected for tests; defaults to SIGTERM self
 *   log?: (msg: string) => void,
 * }} opts
 */
export function startJobHotReload({
  paths,
  debounceMs = DEFAULT_DEBOUNCE_MS,
  signalSelf = () => process.kill(process.pid, 'SIGTERM'),
  log = (msg) => console.log(msg),
}) {
  const watchers = [];
  let timer = null;
  let stopped = false;
  let pendingPath = null;

  function fire() {
    if (stopped) return;
    log(
      `[hot-reload] user-data change detected (${pendingPath}) — restarting daemon to load fresh module graph`,
    );
    pendingPath = null;
    try {
      signalSelf();
    } catch (e) {
      log(`[hot-reload] signalSelf failed: ${e.message}`);
    }
  }

  function schedule(filename) {
    if (stopped) return;
    pendingPath = filename;
    if (timer) clearTimeout(timer);
    timer = setTimeout(fire, debounceMs);
    timer.unref?.();
  }

  for (const dir of paths) {
    try {
      const w = watch(dir, { recursive: true }, (_eventType, filename) => {
        if (!filename) return;
        if (!filename.endsWith('.js')) return;
        // Skip test files — editing tests shouldn't bounce the daemon.
        if (filename.includes('/tests/') || filename.endsWith('.test.js')) return;
        schedule(`${dir}/${filename}`);
      });
      w.on?.('error', (e) => log(`[hot-reload] watcher on ${dir}: ${e.message}`));
      watchers.push(w);
      log(`[hot-reload] watching ${dir}`);
    } catch (e) {
      log(`[hot-reload] failed to watch ${dir}: ${e.message}`);
    }
  }

  return {
    stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      for (const w of watchers) {
        try {
          w.close();
        } catch {
          // already closed
        }
      }
      watchers.length = 0;
    },
  };
}
