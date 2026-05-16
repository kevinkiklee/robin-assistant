// src/jobs/internal/log-rotate.js
// Rotates daemon.log and biographer.log when each exceeds a size threshold.
//
// Strategy: copy-then-truncate so any open file descriptor (launchd holds
// daemon.log via StandardOutPath; the biographer pipeline reopens
// biographer.log per write but a long-running fd elsewhere would stay
// valid) keeps writing to the same inode. The copy becomes <name>.1 (one
// historical archive; no compression).
//
// biographer.log was previously unrotated, which let stale errors from
// weeks-old runs surface forever in `robin doctor`'s biographer probe.
import { copyFileSync, existsSync, statSync, truncateSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from '../../../config/data-store.js';
import { readConfig } from '../../../config/paths.js';

const DEFAULT_THRESHOLD_BYTES = 10 * 1024 * 1024; // 10 MB

function rotateOne(path, threshold) {
  if (!existsSync(path)) return { rotated: false, reason: 'no_log_file' };
  const { size } = statSync(path);
  if (size < threshold) return { rotated: false, sizeBytes: size, threshold };
  copyFileSync(path, `${path}.1`);
  truncateSync(path, 0);
  return { rotated: true, sizeBytes: size, threshold };
}

export default async function logRotate() {
  const logsDir = paths.data.logs();
  const cfg = await readConfig();
  const threshold = cfg?.logs?.rotateAtBytes ?? DEFAULT_THRESHOLD_BYTES;
  const result = {
    'daemon.log': rotateOne(join(logsDir, 'daemon.log'), threshold),
    'biographer.log': rotateOne(join(logsDir, 'biographer.log'), threshold),
  };
  return JSON.stringify(result);
}
