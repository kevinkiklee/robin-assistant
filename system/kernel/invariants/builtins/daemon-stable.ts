import { readFileSync } from 'node:fs';
import type { Invariant } from '../types.ts';

const CRASH_LOOP_THRESHOLD = 3;
const WINDOW_MS = 60 * 60_000; // 1 hour

/**
 * Detects a crash-loop: launchd repeatedly respawning a daemon that exits
 * shortly after boot. Reads the `boots.json` file written by the daemon on
 * each cold start, counts how many timestamps fall within the trailing hour,
 * and fires if >= 3.
 *
 * Missing or corrupt `boots.json` is treated as ok — the invariant must never
 * false-alarm on a fresh install or a corrupted file. Only persistent, rapid
 * restarts within the observation window are flagged.
 *
 * `warning` severity: the daemon may still be running, but the pattern
 * strongly suggests imminent instability.
 */
export function daemonStableInvariant(opts: {
  /** Absolute path to the boots.json file maintained by the daemon on boot. */
  bootsPath: string;
  /** Clock injection for tests. Defaults to `() => new Date()`. */
  now?: () => Date;
}): Invariant {
  const now = opts.now ?? (() => new Date());
  return {
    name: 'daemon.stable',
    severity: 'warning',
    symptom:
      'The daemon has restarted 3 or more times within the last hour, indicating a crash-loop.',
    cause:
      'launchd is repeatedly respawning a crashing daemon — likely an unhandled startup exception, missing resource, or critical import failure.',
    fix: 'Check daemon logs (`user-data/observability/logs/daemon.log`) for the startup error; `launchctl unload` the plist to halt the loop while debugging.',
    check: () => {
      try {
        let boots: unknown;
        try {
          boots = JSON.parse(readFileSync(opts.bootsPath, 'utf8'));
        } catch {
          // Missing or corrupt file — nothing to judge yet.
          return { ok: true };
        }

        if (!Array.isArray(boots)) return { ok: true };

        const windowStart = now().getTime() - WINDOW_MS;
        const recent = (boots as unknown[]).filter((entry) => {
          if (typeof entry !== 'string') return false;
          const ms = Date.parse(entry);
          return Number.isFinite(ms) && ms >= windowStart;
        });

        if (recent.length >= CRASH_LOOP_THRESHOLD) {
          return {
            ok: false,
            message: `daemon restarted ${recent.length} times in the last hour`,
            remediation: 'launchd is respawning a crashing daemon — check logs',
          };
        }
        return { ok: true };
      } catch {
        // Any unexpected error: never false-alarm.
        return { ok: true };
      }
    },
  };
}
