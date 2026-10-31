import { execSync } from 'node:child_process';
import type { RobinDb } from '../../../brain/memory/db.ts';
import { isProcessAlive } from '../../runtime/pidfile.ts';
import type { Invariant } from '../types.ts';

/** How long a wedged process gets after SIGTERM before the repair escalates to
 *  SIGKILL. Injectable so tests don't actually wait 5 real seconds. */
const REAP_WAIT_MS = 5_000;

/** A live pid must be at least this old before it's even considered — 5× the
 *  child's own 60s renewal beat (`RENEW_EVERY_MS` in
 *  `brain/cognition/cognition-runner-entry.ts`), the same margin the previous
 *  lease-based detection used. A younger pid just hasn't had its first
 *  renewal beat yet; flagging it would be a false positive on every fresh
 *  spawn. */
const AGE_THRESHOLD_MS = 5 * 60_000;

/** One live process the enumerator believes is a cognition child. */
export interface ChildProcess {
  pid: number;
  /** Wall-clock ms the process started, derived from its reported age. */
  startedAt: number;
}

/** Parse BSD/macOS `ps -o etime=` output: `[[DD-]HH:]MM:SS`. Returns null on
 *  anything that doesn't match (never throws — a malformed line is skipped by
 *  the caller, not fatal to the whole scan). */
function parseEtimeToMs(etime: string): number | null {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(etime.trim());
  if (!m) return null;
  const days = m[1] ? Number.parseInt(m[1], 10) : 0;
  const hours = m[2] ? Number.parseInt(m[2], 10) : 0;
  const minutes = Number.parseInt(m[3], 10);
  const seconds = Number.parseInt(m[4], 10);
  return ((days * 24 + hours) * 60 + minutes) * 60_000 + seconds * 1000;
}

/** Production process enumerator: a single `ps -axo pid=,etime=,command=`
 *  scan (`-a` all users, `-x` include processes without a controlling tty —
 *  detached children have none) filtered to lines whose command line
 *  mentions `cognition-runner-entry`. `etime` is converted to an absolute
 *  `startedAt` via the wall clock at scan time. Never throws — `ps` being
 *  unavailable, or matching nothing, reads as "no live children" rather than
 *  failing the whole invariant. */
function defaultListChildPids(): ChildProcess[] {
  try {
    const out = execSync('ps -axo pid=,etime=,command=', { encoding: 'utf8' });
    const now = Date.now();
    const children: ChildProcess[] = [];
    for (const line of out.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const m = /^(\d+)\s+(\S+)\s+(.*)$/.exec(trimmed);
      if (!m) continue;
      const [, pidStr, etime, command] = m;
      if (!command.includes('cognition-runner-entry')) continue;
      const pid = Number.parseInt(pidStr, 10);
      const ageMs = parseEtimeToMs(etime);
      if (!Number.isFinite(pid) || ageMs === null) continue;
      children.push({ pid, startedAt: now - ageMs });
    }
    return children;
  } catch {
    return [];
  }
}

/** Production argv lookup for a live pid, re-checked at repair() time (see
 *  `repair` below for why this is a separate call from the enumeration
 *  filter). macOS/BSD has no /proc, so `ps` is the portable way to read a
 *  process's command line. Never throws — a pid that exited between check()
 *  and repair() (or one we lack permission to inspect) reads as ''. */
function defaultArgvOf(pid: number): string {
  try {
    return execSync(`ps -o command= -p ${pid}`, { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function defaultKill(pid: number, signal: NodeJS.Signals): void {
  process.kill(pid, signal);
}

function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface OrphanChildrenOpts {
  /** Injected process enumeration; defaults to a `ps -axo pid=,etime=,command=`
   *  scan filtered to live cognition-runner-entry children. */
  listChildPids?: () => ChildProcess[];
  /** Injected liveness check, used only in repair()'s post-SIGTERM wait;
   *  defaults to isProcessAlive (kernel/runtime/pidfile.ts). */
  isAlive?: (pid: number) => boolean;
  /** Injected argv lookup, re-verified at repair() time; defaults to
   *  `ps -o command= -p <pid>` via execSync. */
  argvOf?: (pid: number) => string;
  /** Injected process signal sender; defaults to process.kill. */
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  /** Injected delay between SIGTERM and the SIGKILL follow-up; defaults to a real 5s wait. */
  delay?: (ms: number) => Promise<void>;
}

interface WedgedChild {
  pid: number;
  /** True when a reaper breadcrumb (`recoverExpiredLeases` in
   *  scheduler/claim.ts) names this exact pid — extra evidence surfaced in
   *  the message, never required for the flag itself. */
  corroborated: boolean;
}

/**
 * A wedged cognition child: a live OS process whose command line still says
 * `cognition-runner-entry`, running for more than 5 minutes, that holds NO
 * current lease (`jobs.claimed_by = 'child:<pid>' AND jobs.state = 'leased'`).
 *
 * This is process-first detection, not lease-first. The previous version of
 * this check queried `state='leased' AND leased_until` stale by 5+ minutes —
 * but the daemon's own 60s in-process lease reaper (`recoverExpiredLeases`,
 * `system/kernel/runtime/daemon.ts`) reclaims any such row (`state='pending'`,
 * `claimed_by=NULL`) within a minute of it going stale, for as long as the
 * daemon is alive to run its reaper tick. That query could therefore only
 * ever match in the narrow window between a daemon crash and this invariant's
 * own next run — structurally vacant in the common case (step-3 final
 * review). Enumerating live processes first and asking "does this pid still
 * hold a lease?" doesn't have that blind spot: the reaper clearing
 * `claimed_by` is exactly the signal that the process is now orphaned, not
 * something that hides the orphan.
 *
 * A reaper breadcrumb (`last_error LIKE 'lease expired (worker=child:<pid>,%'`)
 * is checked as corroboration when present, purely to enrich the message — a
 * missing breadcrumb (row since re-claimed, log rotated, row long gone) never
 * suppresses the flag. Absence of a current lease is sufficient on its own.
 *
 * `argvOf` is the safety rail that makes `repair()` safe to run unattended: a
 * pid can be reused by an unrelated process in the gap between `check()`
 * enumerating it and `repair()` signaling it. Only a pid whose LIVE command
 * line still contains `cognition-runner-entry` at repair time is killed —
 * this is a second, independent check from the one `listChildPids`'s
 * production default already applies at enumeration time, closing that
 * TOCTOU window. `listChildPids`/`isAlive`/`argvOf`/`kill`/`delay` are all
 * injectable (via the factory's opts) so tests exercise the full
 * check/repair logic without spawning or signaling a real process.
 *
 * Doctor-only (registered in `doctor-set.ts`, NOT the 60s in-process
 * health-monitor set): `repair()` sends real signals, and the daily
 * `doctor.run` / manual `robin doctor --fix` cadence is the appropriate place
 * for that, not a check that reruns every minute.
 */
export function orphanChildrenInvariant(db: RobinDb, opts: OrphanChildrenOpts = {}): Invariant {
  const listChildPids = opts.listChildPids ?? defaultListChildPids;
  const isAlive = opts.isAlive ?? isProcessAlive;
  const argvOf = opts.argvOf ?? defaultArgvOf;
  const kill = opts.kill ?? defaultKill;
  const delay = opts.delay ?? defaultDelay;

  const hasCurrentLease = (pid: number): boolean =>
    db
      .prepare(`SELECT 1 FROM jobs WHERE claimed_by=? AND state='leased' LIMIT 1`)
      .get(`child:${pid}`) !== undefined;

  const hasReaperBreadcrumb = (pid: number): boolean =>
    db
      .prepare(
        `SELECT 1 FROM jobs WHERE last_error LIKE 'lease expired (worker=child:' || ? || ',%' LIMIT 1`,
      )
      .get(String(pid)) !== undefined;

  const findWedged = (): WedgedChild[] => {
    const now = Date.now();
    const wedged: WedgedChild[] = [];
    for (const { pid, startedAt } of listChildPids()) {
      if (now - startedAt < AGE_THRESHOLD_MS) continue; // too young — hasn't missed a renewal beat yet
      if (hasCurrentLease(pid)) continue; // still renewing normally — not orphaned
      wedged.push({ pid, corroborated: hasReaperBreadcrumb(pid) });
    }
    return wedged;
  };

  return {
    name: 'cognition.no_orphan_children',
    severity: 'warning',
    symptom:
      'A cognition child (biographer.run / dream.run) process has been running for over 5 minutes with no current job lease — its lease was reaped as stale while the OS process itself is still alive, a wedged process burning CPU/memory without making progress.',
    cause:
      'The renewal timer (60s beat) stopped firing while the process itself never exited — most likely a blocking call inside the job handler that never yields back to the event loop, so the unref’d renewal interval never gets a turn to run.',
    fix: '`robin doctor --fix` sends SIGTERM, waits 5s, and escalates to SIGKILL if the process is still alive. The stale lease itself is reclaimed independently by the daemon’s own lease reaper — this only cleans up the leaked OS process.',
    check: () => {
      const wedged = findWedged();
      if (wedged.length === 0) return { ok: true };
      const pids = wedged
        .map((w) => (w.corroborated ? `${w.pid} (reaper-confirmed)` : `${w.pid}`))
        .join(', ');
      return {
        ok: false,
        message: `${wedged.length} wedged cognition child(ren) alive >5min with no current lease: pid(s) ${pids}`,
        remediation: 'robin doctor --fix (SIGTERM, wait 5s, SIGKILL if still alive)',
      };
    },
    repair: async () => {
      const wedged = findWedged();
      for (const { pid } of wedged) {
        if (!argvOf(pid).includes('cognition-runner-entry')) continue; // pid reused since check() — never touch a stranger
        kill(pid, 'SIGTERM');
        await delay(REAP_WAIT_MS);
        if (isAlive(pid)) kill(pid, 'SIGKILL');
      }
    },
  };
}
