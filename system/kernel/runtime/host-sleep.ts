import { execFileSync } from 'node:child_process';

/**
 * Host sleep detection that doesn't depend on the monotonic clock.
 *
 * The sleep guards in health-monitor and loop-lag compared Date.now() with
 * performance.now() and assumed macOS's monotonic clock stops during sleep. On
 * Node 24 / libuv 1.51 it doesn't: uv_hrtime keeps counting through a clamshell
 * nap, so the measured drift is ~0 and the guards never fire. The daemon log
 * has no "host sleep detected" line at all. On 10/27 every DarkWake raised
 * `daemon.heartbeating` CRITICAL ("last tick was 958113ms ago") plus a matching
 * `daemon.event_loop_blocked` ("957.8 s"), each lining up to the second with a
 * pmset sleep/wake. The kernel records the real transitions, so ask it.
 */

/** Latest `{ sec = N, usec = M }` in sysctl output, as epoch ms. */
export function parseSysctlTimes(out: string): number | null {
  let latest: number | null = null;
  for (const m of out.matchAll(/sec\s*=\s*(\d+)\s*,\s*usec\s*=\s*(\d+)/g)) {
    const ms = Number(m[1]) * 1000 + Math.floor(Number(m[2]) / 1000);
    if (ms > 0 && (latest === null || ms > latest)) latest = ms;
  }
  return latest;
}

/**
 * Epoch ms of the most recent host sleep entry or wake (whichever is later), or
 * null when unknown (non-macOS, or the probe failed). Both are read because a
 * maintenance DarkWake → sleep cycle advances `kern.sleeptime` either way.
 * Linux needs no probe: there CLOCK_MONOTONIC stops in suspend, so the
 * drift check still works.
 *
 * It spawns a process (~5 ms), so callers probe only once a gap is already
 * suspected, not on every tick.
 */
export function lastHostSleepEventAt(): number | null {
  if (process.platform !== 'darwin') return null;
  try {
    const out = execFileSync('/usr/sbin/sysctl', ['-n', 'kern.sleeptime', 'kern.waketime'], {
      encoding: 'utf8',
      timeout: 2_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return parseSysctlTimes(out);
  } catch {
    return null;
  }
}

/** True when the host slept or woke after `sinceMs`, according to `probe`. */
export function hostSleptSince(
  sinceMs: number,
  probe: () => number | null = lastHostSleepEventAt,
): boolean {
  const at = probe();
  return at !== null && at > sinceMs;
}
