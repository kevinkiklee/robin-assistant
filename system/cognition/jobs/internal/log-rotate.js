// src/jobs/internal/log-rotate.js
// Rotates daemon.log when it exceeds a size threshold.
//
// Strategy: copy-then-truncate so the daemon's open file descriptor
// (held open by launchd StandardOutPath) stays valid. The daemon keeps
// writing to the same inode; truncation simply resets the write offset.
// The copy becomes daemon.log.1 (one historical archive; no compression).
import { copyFileSync, existsSync, statSync, truncateSync } from 'node:fs';
import { join } from 'node:path';
import { readConfig } from '../../runtime/config.js';
import { paths } from '../../runtime/data-store.js';

const DEFAULT_THRESHOLD_BYTES = 10 * 1024 * 1024; // 10 MB

export default async function logRotate() {
  const logsDir = paths.data.logs();
  const daemonLog = join(logsDir, 'daemon.log');
  const daemonLogArchive = join(logsDir, 'daemon.log.1');

  if (!existsSync(daemonLog)) {
    return JSON.stringify({ rotated: false, reason: 'no_log_file' });
  }

  const cfg = await readConfig();
  const threshold = cfg?.logs?.rotateAtBytes ?? DEFAULT_THRESHOLD_BYTES;

  const { size } = statSync(daemonLog);
  if (size < threshold) {
    return JSON.stringify({ rotated: false, sizeBytes: size, threshold });
  }

  // Copy current log to .1 (overwrites any existing archive), then truncate
  // in place to preserve the daemon's open file descriptor.
  copyFileSync(daemonLog, daemonLogArchive);
  truncateSync(daemonLog, 0);

  return JSON.stringify({ rotated: true, sizeBytes: size, threshold });
}
