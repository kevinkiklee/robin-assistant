import { execFileSync } from 'node:child_process';
import type { Invariant } from '../types.ts';

/**
 * With `core.fsmonitor = true` (often set globally), git starts a monitor
 * daemon for every repository it touches, temp repos included, and none of
 * them exit when the repository is deleted. Each holds FSEvents streams. A
 * few hundred exhaust macOS's FSEvents capacity, and from then on every
 * `fs.watch` on the machine fails with EMFILE, including the daemon's own
 * hot-reload watcher. Seen 2026-11-02 at ~940 daemons, most from deleted
 * test repos.
 */
const WARN_ABOVE = 200;

const DAEMON_PATTERN = 'git fsmonitor--daemon run';

function defaultListPids(): number[] {
  try {
    const out = execFileSync('pgrep', ['-f', DAEMON_PATTERN], { encoding: 'utf8' });
    return out
      .split('\n')
      .map((l) => Number.parseInt(l.trim(), 10))
      .filter((n) => Number.isFinite(n) && n > 0);
  } catch {
    return []; // pgrep exits 1 when nothing matches
  }
}

function defaultArgvOf(pid: number): string {
  try {
    return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

export interface GitFsmonitorOpts {
  listPids?: () => number[];
  argvOf?: (pid: number) => string;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  warnAbove?: number;
}

export function gitFsmonitorBoundedInvariant(opts: GitFsmonitorOpts = {}): Invariant {
  const listPids = opts.listPids ?? defaultListPids;
  const argvOf = opts.argvOf ?? defaultArgvOf;
  const kill = opts.kill ?? ((pid, sig) => process.kill(pid, sig));
  const warnAbove = opts.warnAbove ?? WARN_ABOVE;
  return {
    name: 'git.fsmonitor_bounded',
    severity: 'warning',
    symptom:
      'File watching fails machine-wide with EMFILE: the integration hot-reload watcher pauses, editors stop noticing changes, and git prints "could not read IPC response".',
    cause:
      'A global core.fsmonitor leaves a git monitor daemon behind for every repository git touched, deleted temp repos included; together they exhaust macOS FSEvents capacity.',
    fix: 'Stop them; git restarts one on demand: `pkill -f "git fsmonitor--daemon run"`. To stop the build-up, turn off the global setting (`git config --global --unset core.fsmonitor`) and enable it per repository instead.',
    check: () => {
      const n = listPids().length;
      if (n <= warnAbove) return { ok: true };
      return {
        ok: false,
        message: `${n} git fsmonitor daemons running (warn above ${warnAbove})`,
        remediation: 'robin doctor --fix',
      };
    },
    // Safe to stop every one: each is a cache git re-spawns on the next command
    // in its repository. Re-checks argv so a recycled pid is never signalled.
    repair: () => {
      for (const pid of listPids()) {
        if (!argvOf(pid).includes(DAEMON_PATTERN)) continue;
        try {
          kill(pid, 'SIGTERM');
        } catch {
          // already gone
        }
      }
    },
  };
}
