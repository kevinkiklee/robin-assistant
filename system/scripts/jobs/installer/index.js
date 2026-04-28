// Cross-platform installer dispatcher. Selects the right adapter and
// exposes a uniform interface used by the reconciler.

import { platform } from 'node:os';
import * as launchd from './launchd.js';
import * as cronLinux from './cron-linux.js';
import * as taskScheduler from './taskscheduler.js';

export function getAdapter(plat = platform()) {
  switch (plat) {
    case 'darwin':
      return makeAdapter(launchd, plat);
    case 'linux':
      return makeAdapter(cronLinux, plat, { batched: true });
    case 'win32':
      return makeAdapter(taskScheduler, plat);
    default:
      return null;
  }
}

function makeAdapter(impl, plat, opts = {}) {
  return {
    platform: plat,
    batched: !!opts.batched,
    listEntries: impl.listEntries || (() => []),
    installEntry: impl.installEntry || null,
    uninstallEntry: impl.uninstallEntry || null,
    syncAll: impl.syncAll || null,
    uninstallAll: impl.uninstallAll || null,
    isHealthy: impl.isHealthy || (() => true),
    impl,
  };
}
