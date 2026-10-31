import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { Invariant } from '../types.ts';

/** Rotate a log once it crosses this size. daemon.log accrues ~0.9 MB/day, so
 *  16 MB ≈ two weeks of history live in the plain file before an archive cut. */
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
/** Compressed archives kept per log basename; older ones are deleted on rotation. */
const DEFAULT_KEEP_ARCHIVES = 5;

/** Archive name for a rotation cut today: `<base>-YYYY-MM-DD.log.gz`, with a
 *  time suffix only when that name is already taken (two cuts in one day). */
function archiveName(base: string, dir: string, now: Date): string {
  const day = now.toISOString().slice(0, 10);
  const plain = `${base}-${day}.log.gz`;
  if (!existsSync(join(dir, plain))) return plain;
  const hms = now.toISOString().slice(11, 19).replace(/:/g, '');
  return `${base}-${day}-${hms}.log.gz`;
}

/**
 * Nothing rotated `observability/logs/*.log`: launchd appends the daemon's
 * stdout/stderr forever (91 MB accrued 2026-05-20 → 08-31 before the first
 * manual cut). Repair gzips each oversized log to `<base>-<date>.log.gz` beside
 * it, truncates the live file IN PLACE, and prunes archives beyond the retention
 * count. Truncation must be in-place (`truncateSync`), never rename-and-recreate:
 * launchd and any writer hold the open fd, and their O_APPEND mode makes the next
 * write land at the new EOF (verified live 2026-08-31 — first post-truncate line
 * wrote at offset 0, no sparse hole). Lines written between the snapshot read and
 * the truncate are lost — the same documented race as logrotate `copytruncate`,
 * accepted for an operational log. Thresholds are injectable so tests stay fast.
 */
export function logsRotationBoundedInvariant(
  logsDir: string,
  opts: { maxBytes?: number; keepArchives?: number; now?: () => Date } = {},
): Invariant {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const keepArchives = opts.keepArchives ?? DEFAULT_KEEP_ARCHIVES;
  const nowFn = opts.now ?? (() => new Date());

  const oversized = (): Array<{ name: string; bytes: number }> => {
    if (!existsSync(logsDir)) return [];
    const hits: Array<{ name: string; bytes: number }> = [];
    for (const name of readdirSync(logsDir)) {
      if (!name.endsWith('.log')) continue;
      const full = join(logsDir, name);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(full);
      } catch {
        continue; // raced away between readdir and stat
      }
      if (st.isFile() && st.size > maxBytes) hits.push({ name, bytes: st.size });
    }
    return hits;
  };

  return {
    name: 'logs.rotation_bounded',
    severity: 'warning',
    symptom:
      'Files under observability/logs/ grow unboundedly; daemon.log reached 91 MB before any rotation existed.',
    cause:
      'launchd StandardOut/ErrorPath appends forever and no logrotate/newsyslog covers a user-home path; nothing ever cut an archive.',
    fix: `Run \`robin doctor --fix\` (the daily doctor gzips oversized logs to <name>-<date>.log.gz, truncates in place, and keeps the newest ${DEFAULT_KEEP_ARCHIVES} archives).`,
    check: () => {
      const hits = oversized();
      if (hits.length === 0) return { ok: true };
      const detail = hits.map((h) => `${h.name} ${(h.bytes / 1048576).toFixed(1)}MB`).join(', ');
      return {
        ok: false,
        message: `${hits.length} log(s) over ${(maxBytes / 1048576).toFixed(0)}MB: ${detail}`,
        remediation: 'robin doctor --fix',
      };
    },
    repair: () => {
      const now = nowFn();
      for (const { name } of oversized()) {
        const base = name.replace(/\.log$/, '');
        const full = join(logsDir, name);
        // Snapshot → compress → cut. A snapshot of a live append-only file is
        // consistent up to its EOF at read time.
        const snapshot = readFileSync(full);
        writeFileSync(join(logsDir, archiveName(base, logsDir, now)), gzipSync(snapshot));
        truncateSync(full, 0);
        // Prune this base's archives beyond the retention count, newest kept.
        // The date-stamped names sort lexicographically in time order.
        const archives = readdirSync(logsDir)
          .filter((f) => f.startsWith(`${base}-`) && f.endsWith('.log.gz'))
          .sort()
          .reverse();
        for (const old of archives.slice(keepArchives)) {
          try {
            unlinkSync(join(logsDir, old));
          } catch {
            // best-effort prune; a locked file just waits for the next run
          }
        }
      }
    },
  };
}
