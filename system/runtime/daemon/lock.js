import { spawnSync } from 'node:child_process';
import { readFile, unlink, writeFile } from 'node:fs/promises';

export function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// Substrings unique to the daemon's command line. Any of these means
// "this PID is actually the daemon," not an unrelated process that
// happens to have inherited a recycled PID.
//   - server.js path → matches the detached spawn from `mcp start`
//   - "robin mcp start" → matches the foreground supervisor invocation
//     (launchd plist or systemd unit running `robin mcp start --foreground`)
const DAEMON_CMDLINE_MARKERS = [
  /\/system\/runtime\/daemon\/server\.js\b/,
  /\brobin\s+mcp\s+start\b/,
];

/**
 * Best-effort check that the given PID is *actually a Robin daemon*, not
 * an unrelated process that PID reuse handed the same number to. Returns
 * `true` only on strong positive evidence. Failure modes (ps missing,
 * unsupported platform, transient error) return `false` so the lock can
 * be safely reclaimed — the worst case is the daemon refuses to start and
 * the user retries.
 */
export function isDaemonProcess(pid) {
  if (!Number.isInteger(pid)) return false;
  if (process.platform !== 'darwin' && process.platform !== 'linux') return false;
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
  if (result.status !== 0) return false;
  const cmd = (result.stdout || '').trim();
  if (!cmd) return false;
  return DAEMON_CMDLINE_MARKERS.some((re) => re.test(cmd));
}

/**
 * Acquire the daemon lock atomically.
 *
 * Algorithm:
 *   1. Attempt `writeFile(path, pid, { flag: 'wx' })` — exclusive create.
 *   2. On EEXIST: read existing pid. If alive **and identified as the
 *      daemon** (`isDaemonProcess`), throw EALREADY.
 *   3. Otherwise (dead pid, malformed, or PID reuse by an unrelated
 *      process), unlink and retry.
 *
 * The wx flag closes the TOCTOU window: we never read-then-write. Multiple
 * daemons racing through dead-pid cleanup converge because at most one of
 * them is alive at any moment. Bounded loop guards against pathological
 * thrashing.
 *
 * Opts:
 *   - `isDaemonProcess` — override the production cmdline-sniff for
 *     tests. Production callers leave this unset and get the real check.
 */
export async function acquireDaemonLock(path, opts = {}) {
  const checkIsDaemon = opts.isDaemonProcess ?? isDaemonProcess;
  // Up to 5 iterations to absorb both empty-file races (a concurrent
  // wx-writer hasn't flushed its pid yet) and the standard
  // dead-pid-cleanup retry.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await writeFile(path, String(process.pid), { flag: 'wx' });
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // Lock exists. Inspect.
      let trimmed;
      try {
        const existing = await readFile(path, 'utf8');
        trimmed = existing.trim();
      } catch {
        // Race: file vanished between EEXIST and read. Retry.
        continue;
      }
      if (trimmed === '') {
        // The wx flag does open(O_CREAT|O_EXCL) followed by write — two
        // syscalls. Another caller may have just won the exclusive open but
        // hasn't written its pid yet. Back off briefly so the next iteration
        // sees the winner's pid instead of an empty file. Do NOT unlink here:
        // unlinking would clobber the live winner.
        await new Promise((r) => setTimeout(r, 10));
        continue;
      }
      const pid = Number.parseInt(trimmed, 10);
      if (Number.isInteger(pid) && isPidAlive(pid) && checkIsDaemon(pid)) {
        const err = new Error(`daemon already running (pid ${pid})`);
        err.code = 'EALREADY';
        throw err;
      }
      // Dead pid, malformed content, OR live-but-not-the-daemon (PID
      // reuse — the recycled number now belongs to some other process,
      // commonly a biographer/dream CLI subcommand). Reclaim.
      await unlink(path).catch(() => {});
    }
  }
  const err = new Error('daemon lock acquisition failed after 5 attempts');
  err.code = 'EALREADY';
  throw err;
}

export async function releaseDaemonLock(path) {
  try {
    await unlink(path);
  } catch {
    /* idempotent */
  }
}
