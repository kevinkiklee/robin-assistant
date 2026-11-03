import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { ExecFn } from '../service/manager.ts';
import { CONTROL_GROUP_ARGV, cgroupProcsArgv } from './migrate.ts';

/** Above every agent (30 min) and cognition (45 min) time cap. */
export const DEFAULT_MAX_AGE_MS = 6 * 3_600_000;
const GRACE_MS = 10_000;

export interface ReapProc {
  pid: number;
  startedAtMs: number;
  cmd: string;
}

/** Pure: cgroup members other than the daemon's main pid that are older than `maxAgeMs`. */
export function reapCandidates(opts: {
  procs: ReapProc[];
  mainPid: number;
  nowMs: number;
  maxAgeMs?: number;
}): number[] {
  const max = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  return opts.procs
    .filter((p) => p.pid !== opts.mainPid && opts.nowMs - p.startedAtMs > max)
    .map((p) => p.pid);
}

/** Start time (ms epoch) from `/proc/<pid>/stat` text: field 22, clock ticks since boot. */
export function parseProcStartMs(stat: string, btimeSec: number, clkTck = 100): number | null {
  const close = stat.lastIndexOf(')');
  if (close < 0) return null;
  const ticks = Number(
    stat
      .slice(close + 1)
      .trim()
      .split(/\s+/)[19],
  );
  if (!Number.isFinite(ticks)) return null;
  return btimeSec * 1000 + Math.round((ticks / clkTck) * 1000);
}

async function readProcLinux(pid: number): Promise<{ startedAtMs: number; cmd: string } | null> {
  try {
    const [stat, sys, cmdline] = await Promise.all([
      readFile(`/proc/${pid}/stat`, 'utf8'),
      readFile('/proc/stat', 'utf8'),
      readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => ''),
    ]);
    const bt = /^btime\s+(\d+)/m.exec(sys);
    if (!bt) return null;
    const startedAtMs = parseProcStartMs(stat, Number(bt[1]));
    if (startedAtMs === null) return null;
    return { startedAtMs, cmd: cmdline.split('\0').filter(Boolean).join(' ') };
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface ReapDeps {
  exec: ExecFn;
  readProc?: (pid: number) => Promise<{ startedAtMs: number; cmd: string } | null>;
  kill?: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => void;
  isAlive?: (pid: number) => boolean;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (line: string) => void;
  dryRun?: boolean;
  maxAgeMs?: number;
}

export async function reap(
  deps: ReapDeps,
): Promise<{ status: 'not-running' | 'done'; pids: number[] }> {
  // biome-ignore lint/suspicious/noConsole: CLI output is the reaper's log
  const log = deps.log ?? ((l: string) => console.log(l));
  const [showCmd, ...showArgs] = [...CONTROL_GROUP_ARGV] as [string, ...string[]];
  let procsArgv: string[][];
  try {
    const { stdout } = await deps.exec(showCmd, showArgs);
    procsArgv = cgroupProcsArgv(stdout);
  } catch {
    log('daemon not running — nothing to reap');
    return { status: 'not-running', pids: [] };
  }
  const [catCmd, ...catArgs] = procsArgv[1] as [string, ...string[]];
  const members = (await deps.exec(catCmd, catArgs)).stdout
    .split('\n')
    .map((l) => Number(l.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  const mainArgs = [...showArgs];
  mainArgs[mainArgs.indexOf('ControlGroup')] = 'MainPID';
  const mainPid = Number((await deps.exec(showCmd, mainArgs)).stdout.trim());
  if (!Number.isInteger(mainPid) || mainPid <= 0) {
    log('daemon not running — nothing to reap');
    return { status: 'not-running', pids: [] };
  }
  const readProc = deps.readProc ?? readProcLinux;
  const procs: ReapProc[] = [];
  for (const pid of members) {
    const info = await readProc(pid);
    if (info) procs.push({ pid, ...info });
  }
  const nowMs = (deps.now ?? Date.now)();
  const pids = reapCandidates({ procs, mainPid, nowMs, maxAgeMs: deps.maxAgeMs });
  const describe = (pid: number): string => {
    const p = procs.find((x) => x.pid === pid) as ReapProc;
    const age = ((nowMs - p.startedAtMs) / 3_600_000).toFixed(1);
    return `${pid} ${basename(p.cmd.split(' ')[0] || '?')} age=${age}h`;
  };
  if (deps.dryRun) {
    for (const pid of pids) log(`would reap ${describe(pid)}`);
    if (pids.length === 0) log('nothing to reap');
    return { status: 'done', pids };
  }
  const kill = deps.kill ?? ((pid, sig) => process.kill(pid, sig));
  const isAlive = deps.isAlive ?? pidAlive;
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const signal = (pid: number, sig: 'SIGTERM' | 'SIGKILL'): void => {
    try {
      kill(pid, sig);
    } catch {
      /* already gone */
    }
  };
  for (const pid of pids) signal(pid, 'SIGTERM');
  if (pids.length > 0) await sleep(GRACE_MS);
  for (const pid of pids) {
    if (isAlive(pid)) signal(pid, 'SIGKILL');
    log(`reaped ${describe(pid)}`);
  }
  return { status: 'done', pids };
}
