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

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, watch } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_DEBOUNCE_MS = 2_000;

/**
 * Best-effort state writer. Errors are swallowed — losing observability is
 * preferable to crashing the daemon over a state-row write.
 *
 * Returns the promise so callers that need ordering against subsequent
 * invariant evaluation (e.g. daemon boot calling startJobHotReload before
 * runBootInvariants) can await it. Other callers can ignore the return.
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
  // Track last-seen mtime AND content hash per file. macOS fsevents (and to
  // a lesser degree Linux inotify under heavy IO) fires `change` for events
  // that don't actually modify the file — Spotlight indexing, antivirus
  // scans, atime updates. Without this gate, a SIGTERM-respawn cycle fires
  // every ~100ms on a single phantom event and cuts in-flight syncs
  // mid-write (gmail first-sync, lunch_money transaction window).
  //
  // mtime alone is necessary but not sufficient: `touch <file>`, `git
  // checkout` on the same branch, and rsync-style refresh-without-change all
  // advance mtime without changing content. We've seen those produce
  // pointless daemon bounces. The content-hash check costs one sha256 per
  // event (~µs for small JS files) and turns those into no-ops.
  const mtimes = new Map();
  const hashes = new Map();

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

  function hashFile(absPath) {
    try {
      const buf = readFileSync(absPath);
      return createHash('sha256').update(buf).digest('hex');
    } catch {
      return null;
    }
  }

  function actuallyChanged(absPath) {
    let mtimeMs;
    try {
      mtimeMs = statSync(absPath).mtimeMs;
    } catch {
      // File deleted between fsevent and stat. Treat as a real change so
      // the daemon picks up the removal.
      mtimes.delete(absPath);
      hashes.delete(absPath);
      return true;
    }
    const prevMtime = mtimes.get(absPath);
    mtimes.set(absPath, mtimeMs);
    // First sighting always fires (treat as real to be safe — boot-time
    // seeding pre-populates the cache so a known file won't false-trigger
    // here unless it was created since boot).
    if (prevMtime === undefined) return true;
    // mtime didn't advance — fsevents phantom; skip without re-reading file.
    if (mtimeMs <= prevMtime) return false;
    // mtime advanced — verify content actually changed. `touch`, git
    // checkout, and atime-style refreshes all bump mtime without changing
    // bytes; restarting on those is pure cost.
    const prevHash = hashes.get(absPath);
    const newHash = hashFile(absPath);
    if (newHash == null) return true; // read race — fire to be safe
    hashes.set(absPath, newHash);
    return prevHash === undefined || newHash !== prevHash;
  }

  function schedule(absPath) {
    if (stopped) return;
    if (!actuallyChanged(absPath)) return;
    pendingPath = absPath;
    if (timer) clearTimeout(timer);
    timer = setTimeout(fire, debounceMs);
    timer.unref?.();
  }

  // Pre-populate the mtime cache so existing files have a baseline.
  // Without this, the first fsevent on any pre-existing file fires the
  // restart unconditionally (treated as "first sighting"). fsevents
  // frequently emit a phantom event for files in a freshly-watched dir
  // during the first second after `watch()` registers, which fast-pathed
  // an immediate restart on every daemon boot.
  function seedMtimes(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = join(dir, ent.name);
      if (ent.isDirectory()) {
        seedMtimes(full);
        continue;
      }
      if (!ent.name.endsWith('.js')) continue;
      if (ent.name.endsWith('.test.js')) continue;
      try {
        mtimes.set(full, statSync(full).mtimeMs);
        const h = hashFile(full);
        if (h != null) hashes.set(full, h);
      } catch {
        // Race with deletion — leave unset; first real event will fire.
      }
    }
  }

  for (const dir of paths) {
    seedMtimes(dir);
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
  // The returned `ready` promise lets callers (specifically the daemon boot
  // path) order this write before `runBootInvariants` reads the row. Other
  // callers can ignore `ready`; the watcher itself does not depend on it.
  const ready = writeWatcherState(db, {
    active: watchers.length > 0,
    registered_at: new Date().toISOString(),
  });

  return {
    ready,
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
