// Canonical paths under a workspace for the job system.

import { join } from 'node:path';

export function jobsPaths(workspaceDir) {
  const stateDir = join(workspaceDir, 'user-data/runtime/state/jobs');
  return {
    workspaceDir,
    systemJobsDir: join(workspaceDir, 'system/jobs'),
    userJobsDir: join(workspaceDir, 'user-data/runtime/jobs'),
    stateDir,
    indexMd: join(stateDir, 'INDEX.md'),
    upcomingMd: join(stateDir, 'upcoming.md'),
    failuresMd: join(stateDir, 'failures.md'),
    workspacePathFile: join(stateDir, 'workspace-path'),
    syncHashFile: join(stateDir, 'sync-hash'),
    notificationStateFile: join(stateDir, 'notification-state.json'),
    locksDir: join(stateDir, 'locks'),
    logsDir: join(stateDir, 'logs'),
    stateJSON: (name) => join(stateDir, `${name}.json`),
    lockFile: (name) => join(stateDir, 'locks', `${name}.lock`),
    syncLock: join(stateDir, 'locks', '_sync.lock'),
    log: (name, ts) => join(stateDir, 'logs', `${name}-${ts}.log`),
    runnerLog: (name, ts) => join(stateDir, 'logs', `${name}-${ts}.runner.log`),
    summaryLog: (name, ts) => join(stateDir, 'logs', `${name}-${ts}.summary.log`),
  };
}

// `YYYYMMDD-HHMMSS` UTC, lexicographically sortable.
export function logTimestamp(date = new Date()) {
  const iso = date.toISOString();
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}-${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}`;
}
