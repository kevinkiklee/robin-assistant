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
 * Best-effort state writer. Errors are swallowed — losing observability is
 * preferable to crashing the daemon over a state-row write.
 */
async function writeWatcherState(db, fields) {
  if (!db) return;
  try {
    const builder = db.query(
      `UPSERT runtime_state:hot_reload_watcher CONTENT {
        active: $active,
        registered_at: $registered_at
      };`,
      fields,
    );
    if (builder && typeof builder.collect === 'function') {
      await builder.collect();
    }
  } catch {
    // intentionally silent — state writes must not crash the watcher
  }
}

/**
 * Start a hot-reload watcher. Returns `{ stop }`.
 *
 * @param {{
 *   paths: string[],            // directories to watch recursively
 *   debounceMs?: number,        // coalesce rapid edits (default 2s)
 *   signalSelf?: () => void,    // injected for tests; defaults to SIGTERM self
 *   log?: (msg: string) => void,
 *   db?: object,                // OPTIONAL — if provided, watcher writes
 *                               // runtime:hot_reload_watcher state row on
 *                               // start/stop for the
 *                               // runtime.hot_reload_watcher_active invariant
 * }} opts
 */
export function startJobHotReload({
  paths,
  debounceMs = DEFAULT_DEBOUNCE_MS,
  signalSelf = () => process.kill(process.pid, 'SIGTERM'),
  log = (msg) => console.log(msg),
  db = null,
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

  // Record presence for the runtime.hot_reload_watcher_active invariant.
  // Fire-and-forget: avoids forcing every caller to await an async start.
  writeWatcherState(db, {
    active: watchers.length > 0,
    registered_at: new Date().toISOString(),
  });

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
      // Mark inactive on shutdown so the invariant can distinguish "watcher
      // running" from "process down".
      writeWatcherState(db, { active: false, registered_at: new Date().toISOString() });
    },
  };
}
