// Build a ctx for invariant check/repair invocations.
//
// Production callers pass real db handle / logger / paths. Tests pass stubs.
// ctx.db may be null (e.g. when the DB itself is the invariant under test).
// ctx.log falls back to process.stderr when log path is unavailable.

import { getActiveQueryCount } from '../../data/db/client.js';

const noopLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

function makeStderrLog(prefix) {
  const emit =
    (level) =>
    (...args) => {
      const line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
      process.stderr.write(`[${prefix}:${level}] ${line}\n`);
    };
  return {
    info: emit('info'),
    warn: emit('warn'),
    error: emit('error'),
    debug: emit('debug'),
  };
}

export function makeCtx({
  db = null,
  dbFactory = null,
  log = null,
  paths = null,
  state = null,
  dryRun = false,
  trigger = 'doctor',
  logFallback = true,
} = {}) {
  return {
    db,
    dbFactory,
    log: log ?? (logFallback ? makeStderrLog('invariant') : noopLog),
    paths,
    state,
    dryRun,
    trigger,
    // Snapshot of in-flight `db.query(...).collect()` calls at tick start.
    // Read by `mcp.daemon_authenticated_after_reconnect` to skip its
    // synthetic reconnect probe when real traffic is mid-flight. Module-
    // scoped in `data/db/client.js`, so any open handle contributes.
    activeQueryCount: getActiveQueryCount(),
  };
}
