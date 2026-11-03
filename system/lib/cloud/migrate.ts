import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { isProcessAlive, readPidfile } from '../../kernel/runtime/pidfile.ts';
import {
  countEvents,
  DAEMON_LEASED_SQL,
  daemonLeasedJobs,
  dbHeldOpenElsewhere as dbHeldOpenElsewhereDefault,
} from '../../surfaces/cli/db.ts';
import { setPowerState } from '../../surfaces/cli/power.ts';
import { LAUNCHD_LABEL, plistPath } from '../launchd/install.ts';
import { dbFilePath, pidFilePath } from '../paths.ts';
import {
  type CloudRole,
  type CloudRoleRecord,
  clearRole,
  parseRoleRecord,
  readRole,
  writeRole,
} from './role.ts';
import {
  type ArgvRunner,
  execArgv,
  MOVE_EXCLUDES,
  type Remote,
  restoreMacOnlyRows,
  scrubMacOnlyRows,
  snapshotDb,
  sshRemote,
} from './transfer.ts';

/**
 * `robin cloud status | dry-run | cutover | rollback --host <alias>`: move the
 * live instance between this Mac and a Linux VM with exactly one writer at
 * every moment. Order is fixed — lock source → pause → drain → stop → snapshot
 * → transfer → mark target → start → verify → resume. Every external effect
 * (ssh/rsync, launchctl, ps/lsof, sleeping, prompting) is injectable.
 */

export type CloudCmd = 'status' | 'dry-run' | 'cutover' | 'rollback';

/** Both Mac writers: the daemon and the claude.ai connector (`robin mcp remote`, write scope). */
export const MAC_SERVICE_LABELS: readonly string[] = [
  LAUNCHD_LABEL,
  'io.robin-assistant.mcp-remote',
];

/** argv fragments of Robin's detached children, which outlive the daemon's stop. */
export const MAC_CHILD_PATTERNS: readonly string[] = [
  'dist/agent/runner-entry',
  'dist/brain/cognition/cognition-runner-entry',
  'land-probation',
];

const VM_UNIT = 'robin-daemon';
const VM_CHECKOUT = 'robin-assistant-v3';
export const HEALTH_URL = 'http://127.0.0.1:41273/health';
const CLI_JS = 'dist/surfaces/cli/index.js';

export interface Proc {
  pid: number;
  cmd: string;
}

export interface ServiceControl {
  stopMac(): Promise<void>;
  disableMac(): Promise<void>;
  /** `launchctl enable` only (no load): harmless while locked, so it runs before the unlock. */
  enableMac(): Promise<void>;
  enableAndStartMac(): Promise<void>;
}

export interface MacProcs {
  /** Robin's detached children (agent runs, cognition, auto-land probation). */
  children(): Promise<Proc[]>;
  /** Processes other than this one holding the DB (or its -wal) open. */
  dbHolders(dbPath: string): Promise<Proc[]>;
}

export type CloudSignal = 'SIGINT' | 'SIGTERM';

export interface SignalSource {
  on(signal: CloudSignal, handler: () => void): void;
  off(signal: CloudSignal, handler: () => void): void;
}

const processSignals: SignalSource = {
  on: (s, h) => void process.on(s, h),
  off: (s, h) => void process.off(s, h),
};

export interface Timing {
  /** Waiting for in-flight work after the pause (agent runs cap at 30 min, cognition 45). */
  drainMs: number;
  /** Waiting for the last DB holders once the services are stopped. */
  quiesceMs: number;
  pollMs: number;
  /** Waiting for /health after a start. */
  healthMs: number;
  /** Waiting for the first job/integration run on a cut-over VM. */
  activityMs: number;
}

export const DEFAULT_TIMING: Timing = {
  drainMs: 50 * 60_000,
  quiesceMs: 10 * 60_000,
  pollMs: 5_000,
  healthMs: 120_000,
  activityMs: 15 * 60_000,
};

export interface DbOps {
  snapshot(userData: string, outPath: string): void;
  scrub(dbPath: string, opts: { liveDbPath?: string }): { removed: number; derived: number };
  restore(from: string, into: string): { restored: number; derived: number; skipped: number };
}

export interface RunCloudOpts {
  host: string;
  userData: string;
  /** This Mac's checkout (its HEAD must match the VM's; its dist/ runs doctor). */
  repoRoot: string;
  remote?: Remote;
  service?: ServiceControl;
  now?: () => Date;
  log?: (line: string) => void;
  yes?: boolean;
  acceptGaps?: boolean;
  /** Unlock-only rollback after the VM ran as primary (its WHOOP token may have rotated). */
  acceptTokenReset?: boolean;
  /** Liveness of an op-lock holder (default: signal 0). */
  pidAlive?: (pid: number) => boolean;
  /** Where SIGINT/SIGTERM handlers go (default: process). */
  signals?: SignalSource;
  /** Process exit after a signal (default: process.exit). */
  exit?: (code: number) => void;
  /** Local argv runner (git, rsync, curl, ps, lsof, launchctl, doctor). */
  run?: ArgvRunner;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Jobs the Mac daemon runs in-process and still holds leased. Default: the
   * live DB read-only, while the daemon's pidfile names a live process.
   */
  macLeasedJobs?: () => number;
  /** Interactive confirmation; `null` = no TTY. Default: stdin when it is a TTY. */
  prompt?: ((question: string) => Promise<string>) | null;
  macProcs?: MacProcs;
  dbHeldOpenElsewhere?: (dbPath: string) => boolean;
  claudeSettingsPath?: string;
  tmpRoot?: string;
  power?: (userData: string, state: 'paused' | 'active') => void;
  dbOps?: Partial<DbOps>;
  timing?: Partial<Timing>;
}

// ---------------------------------------------------------------------------
// Pure helpers

/** Remote `robin` argv. ssh starts in $HOME; flags use the `--flag=value` form the CLI parses. */
export function remoteCliArgv(repo: string, args: string[]): string[] {
  return [
    'env',
    `--chdir=${repo}`,
    `ROBIN_USER_DATA_DIR=${repo}/user-data`,
    'node',
    CLI_JS,
    ...args,
  ];
}

export const CONTROL_GROUP_ARGV: readonly string[] = [
  'systemctl',
  '--user',
  'show',
  '-p',
  'ControlGroup',
  '--value',
  VM_UNIT,
];

/**
 * A `ControlGroup` value we may read procs from. Empty (an inactive unit) or
 * any path not ending in the daemon's own unit would resolve to some other
 * cgroup — the root one, at worst — so it is an error, never read.
 */
export function validControlGroup(raw: string): string {
  const cg = raw.trim();
  const segs = cg.split('/');
  if (
    !/^\/[A-Za-z0-9@._/-]*\/robin-daemon\.service$/.test(cg) ||
    segs.some((s, i) => i > 0 && (s === '' || s === '.' || s === '..'))
  ) {
    throw new Error(
      `robin-daemon has no usable control group (${JSON.stringify(cg)}); expected …/robin-daemon.service`,
    );
  }
  return cg;
}

/**
 * The daemon cgroup's procs, as argv: the `ControlGroup` query, then (given a
 * value it returned) the `cgroup.procs` read. Task 5's reaper reuses it.
 */
export function cgroupProcsArgv(controlGroup?: string): string[][] {
  const show = [...CONTROL_GROUP_ARGV];
  if (controlGroup === undefined) return [show];
  return [show, ['cat', `/sys/fs/cgroup${validControlGroup(controlGroup)}/cgroup.procs`]];
}

/** `ps -axo pid=,command=` output. */
export function parsePs(stdout: string): Proc[] {
  const out: Proc[] = [];
  for (const line of stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(.*\S)\s*$/.exec(line);
    if (m) out.push({ pid: Number(m[1]), cmd: m[2] });
  }
  return out;
}

/** `lsof -Fpc` output (p/c fields; others ignored), minus `selfPid`. */
export function parseLsof(stdout: string, selfPid: number): Proc[] {
  const out = new Map<number, string>();
  let pid = 0;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('p')) {
      pid = Number(line.slice(1));
      if (Number.isInteger(pid) && pid > 0 && pid !== selfPid && !out.has(pid)) out.set(pid, '');
    } else if (line.startsWith('c') && out.has(pid)) {
      out.set(pid, line.slice(1));
    }
  }
  return [...out].map(([p, cmd]) => ({ pid: p, cmd }));
}

/** GNU rsync ≥ 3 has `--info=progress2`; macOS /usr/bin/rsync is openrsync. */
export function parseRsyncVersion(stdout: string): { gnu: boolean; major: number } {
  const m = /^rsync\s+version\s+v?(\d+)\./m.exec(stdout);
  const major = m ? Number(m[1]) : 0;
  return { gnu: !!m && !/openrsync/i.test(stdout), major };
}

/**
 * The state machine (local role × remote role). `rollback` with a remote
 * `vm-primary` moves the data home; with any other remote role it only unlocks
 * the Mac. A lock taken for another host is not this host's to act on.
 */
export function allowedCommands(
  local: CloudRoleRecord | null,
  remote: CloudRole | null,
  host: string,
  rollingBack = false,
): CloudCmd[] {
  const out: CloudCmd[] = ['status'];
  const remoteHeldOrNone = remote === null || remote === 'vm-dry-run';
  const lockedHere = local?.role === 'mac-locked' && local.host === host;
  // A data rollback already held the VM (vm-dry-run) but has not brought the
  // data home: only finishing it is safe — a cutover would push the stale Mac
  // DB over the VM's, an unlock would resume on it.
  if (lockedHere && rollingBack) return [...out, 'rollback'];
  if (local === null && remoteHeldOrNone) out.push('dry-run');
  if (remoteHeldOrNone && (local === null || lockedHere)) out.push('cutover');
  if (lockedHere) out.push('rollback');
  return out;
}

export async function waitQuiescent(
  listChildren: () => Promise<Proc[]>,
  opts: {
    timeoutMs: number;
    pollMs: number;
    sleep?: (ms: number) => Promise<void>;
    onWait?: (procs: Proc[]) => void;
  },
): Promise<{ ok: true } | { ok: false; remaining: Proc[] }> {
  const sleep = opts.sleep ?? defaultSleep;
  let waited = 0;
  for (;;) {
    const procs = await listChildren();
    if (procs.length === 0) return { ok: true };
    if (waited >= opts.timeoutMs) return { ok: false, remaining: procs };
    opts.onWait?.(procs);
    await sleep(opts.pollMs);
    waited += opts.pollMs;
  }
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const defaultLog = (line: string): void => {
  // biome-ignore lint/suspicious/noConsole: CLI output
  console.log(line);
};

// ---------------------------------------------------------------------------
// Default effects

/**
 * The default local runner: like `execArgv`, but an rsync transfer streams its
 * `--info=progress2` line to the terminal (a 1.4 GB move is minutes of silence otherwise).
 */
export const localRunner: ArgvRunner = (cmd, args) => {
  if (!/(^|\/)rsync$/.test(cmd) || !args.includes('--info=progress2')) return execArgv(cmd, args);
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'inherit', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('error', (err) => resolve({ code: 127, stdout: '', stderr: stderr + err.message }));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout: '', stderr }));
  });
};

/**
 * launchd control for both Mac labels. Stopping tolerates an already-stopped
 * service (a re-run after a partial cutover) and stops anything loaded even
 * without a plist; disable/enable/bootstrap skip a label whose plist is absent.
 */
export function macServiceControl(
  opts: { run?: ArgvRunner; uid?: number; home?: string; labels?: readonly string[] } = {},
): ServiceControl {
  const run = opts.run ?? execArgv;
  const domain = `gui/${opts.uid ?? process.getuid?.() ?? 501}`;
  const labels = opts.labels ?? MAC_SERVICE_LABELS;
  const plist = (label: string) => plistPath({ home: opts.home, label });
  const loaded = async (label: string) =>
    (await run('launchctl', ['print', `${domain}/${label}`])).code === 0;
  const must = async (args: string[]) => {
    const r = await run('launchctl', args);
    if (r.code !== 0) {
      throw new Error(`launchctl ${args.join(' ')} failed (exit ${r.code}): ${tail(r.stderr)}`);
    }
  };
  return {
    async stopMac() {
      for (const label of labels) {
        if (!(await loaded(label))) continue;
        const r = await run('launchctl', ['bootout', `${domain}/${label}`]);
        if (r.code !== 0 && (await loaded(label))) {
          throw new Error(`launchctl bootout ${label} failed (exit ${r.code}): ${tail(r.stderr)}`);
        }
      }
    },
    async disableMac() {
      for (const label of labels) {
        if (existsSync(plist(label))) await must(['disable', `${domain}/${label}`]);
      }
    },
    async enableMac() {
      for (const label of labels) {
        if (existsSync(plist(label))) await must(['enable', `${domain}/${label}`]);
      }
    },
    async enableAndStartMac() {
      for (const label of labels) {
        if (!existsSync(plist(label))) continue;
        await must(['enable', `${domain}/${label}`]);
        if (await loaded(label)) continue;
        const r = await run('launchctl', ['bootstrap', domain, plist(label)]);
        if (r.code !== 0 && !(await loaded(label))) {
          throw new Error(
            `launchctl bootstrap ${label} failed (exit ${r.code}): ${tail(r.stderr)}`,
          );
        }
      }
    },
  };
}

/** Mac children via `ps`, DB holders via `lsof` (argv; this process excluded). */
export function macProcLister(run: ArgvRunner, selfPid: number = process.pid): MacProcs {
  const ps = async (): Promise<Proc[]> => {
    const r = await run('ps', ['-axo', 'pid=,command=']);
    if (r.code !== 0) throw new Error(`ps failed (exit ${r.code}): ${tail(r.stderr)}`);
    return parsePs(r.stdout).filter((p) => p.pid !== selfPid);
  };
  return {
    async children() {
      return (await ps()).filter((p) => MAC_CHILD_PATTERNS.some((pat) => p.cmd.includes(pat)));
    },
    async dbHolders(dbPath) {
      const r = await run('lsof', ['-Fpc', dbPath, `${dbPath}-wal`]);
      // 1 = nothing open / a named file missing (the -wal often is); anything else is a failure
      if (r.code !== 0 && r.code !== 1) {
        throw new Error(`lsof failed (exit ${r.code}): ${tail(r.stderr)}`);
      }
      const holders = parseLsof(r.stdout, selfPid);
      if (holders.length === 0) return [];
      const full = new Map((await ps()).map((p) => [p.pid, p.cmd]));
      return holders.map((h) => ({ pid: h.pid, cmd: full.get(h.pid) ?? h.cmd }));
    },
  };
}

async function ttyPrompt(question: string): Promise<string> {
  const { createInterface } = await import('node:readline');
  return new Promise((done) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    // Ctrl-C at the prompt (readline holds the TTY in raw mode) = not confirmed.
    rl.on('SIGINT', () => {
      rl.close();
      done('');
    });
    rl.question(question, (answer) => {
      rl.close();
      done(answer);
    });
  });
}

// ---------------------------------------------------------------------------
// Remote helpers

/**
 * One constant script for the VM-side DB reads, run as `node -e` from the
 * checkout (so `better-sqlite3` resolves); values arrive as argv, never
 * interpolated. Prints counts only — no row contents leave the VM.
 */
export const VM_DB_SCRIPT = `
const D = require('better-sqlite3');
const fs = require('node:fs');
const [mode, a, b] = process.argv.slice(1);
const ro = (p) => new D(p, { readonly: true, fileMustExist: true });
const n = (db, sql, ...v) => db.prepare(sql).get(...v).n;
if (mode === 'count') {
  const db = ro(a);
  console.log(n(db, 'SELECT count(*) AS n FROM events'));
  db.close();
} else if (mode === 'activity') {
  const since = new Date(b).toISOString();
  const db = ro(a);
  const jobs = n(db, "SELECT count(*) AS n FROM jobs WHERE state IN ('completed','errored') AND created_at > ?", since.slice(0, 19).replace('T', ' '));
  const integrations = n(db, "SELECT count(*) AS n FROM integration_state WHERE key = 'last_attempt_at' AND value > ?", since);
  console.log(JSON.stringify({ jobs, integrations }));
  db.close();
} else if (mode === 'leased') {
  if (!fs.existsSync(a)) { console.log(0); process.exit(0); }
  const db = ro(a);
  console.log(n(db, ${JSON.stringify(DAEMON_LEASED_SQL)}));
  db.close();
} else if (mode === 'held') {
  if (!fs.existsSync(a)) { console.log('free'); process.exit(0); }
  const db = new D(a, { fileMustExist: true });
  try { db.pragma('wal_checkpoint(TRUNCATE)'); } finally { db.close(); }
  console.log(fs.existsSync(a + '-wal') ? 'held' : 'free');
} else if (mode === 'carry-oauth') {
  if (!fs.existsSync(a)) { console.log(0); process.exit(0); }
  const t = (s) => { const v = Date.parse(/^\\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d:\\d\\d$/.test(s) ? s.replace(' ', 'T') + 'Z' : s); return Number.isNaN(v) ? 0 : v; };
  const live = new D(a, { fileMustExist: true }); // the VM daemon is stopped; a leftover -wal needs a writable open
  const rows = live.prepare("SELECT integration_name, key, value, updated_at FROM integration_state WHERE key LIKE '%refresh_token%' OR key LIKE '%access_token%'").all();
  live.close();
  const inc = new D(b, { fileMustExist: true });
  const get = inc.prepare('SELECT updated_at FROM integration_state WHERE integration_name = ? AND key = ?');
  // Only rows the incoming DB still has: a token the Mac deleted is never resurrected.
  const up = inc.prepare('UPDATE integration_state SET value = ?, updated_at = ? WHERE integration_name = ? AND key = ?');
  let carried = 0;
  inc.transaction(() => {
    for (const r of rows) {
      const cur = get.get(r.integration_name, r.key);
      if (cur && t(r.updated_at) > t(cur.updated_at)) { up.run(r.value, r.updated_at, r.integration_name, r.key); carried++; }
    }
  })();
  inc.close();
  console.log(carried);
} else { console.error('unknown mode ' + mode); process.exit(2); }
`;

const ROLE_READ_SH = 'test -e "$1" || exit 3; cat -- "$1"';
const ROLE_WRITE_SH =
  'umask 077 && mkdir -p -- "$(dirname -- "$1")" && printf "%s\\n" "$2" > "$1.tmp" && mv -f -- "$1.tmp" "$1"';
const DB_INSTALL_SH = 'rm -f -- "$1-wal" "$1-shm" "$1-journal" && mv -f -- "$1.incoming" "$1"';

interface VmPaths {
  repo: string;
  userData: string;
  dbDir: string;
  db: string;
  runtime: string;
  role: string;
  backups: string;
}

function vmPaths(home: string): VmPaths {
  const repo = `${home}/${VM_CHECKOUT}`;
  const userData = `${repo}/user-data`;
  return {
    repo,
    userData,
    dbDir: `${userData}/state/db`,
    db: `${userData}/state/db/robin.sqlite`,
    runtime: `${userData}/state/runtime`,
    role: `${userData}/state/runtime/cloud-role.json`,
    backups: `${userData}/backups`,
  };
}

const tail = (s: string) => s.trim().slice(-500) || '(no output)';

// ---------------------------------------------------------------------------
// The orchestrator

class Ctx {
  readonly log: (line: string) => void;
  readonly run: ArgvRunner;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => Date;
  readonly timing: Timing;
  readonly service: ServiceControl;
  readonly macProcs: MacProcs;
  readonly heldOpen: (dbPath: string) => boolean;
  readonly power: (userData: string, state: 'paused' | 'active') => void;
  readonly db: DbOps;
  readonly remote: Remote;
  readonly macDb: string;
  readonly macLeased: () => number;
  rsync: string | undefined;
  vm!: VmPaths;
  macHead = '';
  /** `at` of the mac-locked record this run holds (re-checked before point-of-no-return steps). */
  lockAt = '';
  /** `[n/N] title` of the step running now (for an interrupt message). */
  current = '';
  /** Exit code once a signal stopped the run: no further step starts. */
  aborted: number | null = null;
  private tmp: string | undefined;

  constructor(
    readonly cmd: CloudCmd,
    readonly o: RunCloudOpts,
  ) {
    this.log = o.log ?? defaultLog;
    this.run = o.run ?? localRunner;
    this.sleep = o.sleep ?? defaultSleep;
    this.now = o.now ?? (() => new Date());
    this.timing = { ...DEFAULT_TIMING, ...o.timing };
    this.service = o.service ?? macServiceControl({ run: this.run });
    this.macProcs = o.macProcs ?? macProcLister(this.run);
    this.heldOpen = o.dbHeldOpenElsewhere ?? dbHeldOpenElsewhereDefault;
    this.power = o.power ?? setPowerState;
    this.db = {
      snapshot: o.dbOps?.snapshot ?? snapshotDb,
      scrub: o.dbOps?.scrub ?? scrubMacOnlyRows,
      restore: o.dbOps?.restore ?? restoreMacOnlyRows,
    };
    this.macDb = dbFilePath(o.userData);
    this.macLeased =
      o.macLeasedJobs ??
      (() => {
        const pid = readPidfile(pidFilePath(o.userData));
        return pid && isProcessAlive(pid) ? daemonLeasedJobs(this.macDb) : 0;
      });
    this.remote = o.remote ?? this.sshWithResolvedRsync(o.host);
  }

  /** ssh for exec now; rsync transfers use the binary preflight resolved. */
  private sshWithResolvedRsync(host: string): Remote {
    const base = sshRemote(host, this.run);
    const xfer = () => {
      if (!this.rsync) throw new Error('rsync not resolved (preflight did not run)');
      return sshRemote(host, this.run, { rsync: this.rsync });
    };
    return {
      host,
      exec: (argv) => base.exec(argv),
      // Forward every argument: a dropped option (pull's backupDir) fails silently.
      push: (...a) => xfer().push(...a),
      pull: (...a) => xfer().pull(...a),
      pushFile: (...a) => xfer().pushFile(...a),
      pullFile: (...a) => xfer().pullFile(...a),
    };
  }

  tmpDir(): string {
    this.tmp ??= mkdtempSync(join(this.o.tmpRoot ?? tmpdir(), 'robin-cloud-'));
    return this.tmp;
  }

  cleanup(): void {
    if (this.tmp) rmSync(this.tmp, { recursive: true, force: true });
  }

  detail(line: string): void {
    this.log(`      ${line}`);
  }

  stamp(): string {
    return this.now().toISOString().replace(/[:.]/g, '-');
  }

  // --- remote primitives ---

  async exec(argv: string[], what: string): Promise<string> {
    const r = await this.remote.exec(argv);
    if (r.code !== 0)
      throw new Error(`${what} failed on ${this.o.host} (exit ${r.code}): ${tail(r.stderr)}`);
    return r.stdout;
  }

  async connect(): Promise<void> {
    const t = await this.remote.exec(['true']);
    if (t.code !== 0) {
      throw new Error(`cannot reach ${this.o.host} over ssh (exit ${t.code}): ${tail(t.stderr)}`);
    }
    const home = (await this.exec(['sh', '-c', 'printf %s "$HOME"'], 'reading $HOME')).trim();
    if (!/^\/[^\s]*$/.test(home))
      throw new Error(`unusable VM home directory: ${JSON.stringify(home)}`);
    this.vm = vmPaths(home);
  }

  async remoteRole(): Promise<CloudRoleRecord | null> {
    const r = await this.remote.exec(['sh', '-c', ROLE_READ_SH, 'sh', this.vm.role]);
    if (r.code === 3) return null;
    if (r.code !== 0)
      throw new Error(`reading the VM's role failed (exit ${r.code}): ${tail(r.stderr)}`);
    let rec: CloudRoleRecord | null = null;
    try {
      rec = parseRoleRecord(JSON.parse(r.stdout) as unknown);
    } catch {
      rec = null;
    }
    // A present-but-unreadable marker could be a vm-primary: never treat it as none.
    if (!rec)
      throw new Error(`the VM's role file ${this.vm.role} is unreadable; fix or remove it by hand`);
    return rec;
  }

  async writeRemoteRole(role: CloudRole): Promise<void> {
    const rec: CloudRoleRecord = {
      role,
      at: this.now().toISOString(),
      commit: this.macHead || undefined,
    };
    const json = JSON.stringify(rec);
    await this.exec(['sh', '-c', ROLE_WRITE_SH, 'sh', this.vm.role, json], `writing role ${role}`);
  }

  async cli(args: string[], what: string): Promise<string> {
    return this.exec(remoteCliArgv(this.vm.repo, args), what);
  }

  async vmDb(mode: string, ...args: string[]): Promise<string> {
    const argv = ['env', `--chdir=${this.vm.repo}`, 'node', '-e', VM_DB_SCRIPT, mode, ...args];
    return (await this.exec(argv, `VM DB ${mode}`)).trim();
  }

  async vmActive(): Promise<string> {
    const r = await this.remote.exec(['systemctl', '--user', 'is-active', VM_UNIT]);
    return r.stdout.trim().split('\n')[0] || (r.code === 0 ? 'active' : 'unknown');
  }

  async vmStop(): Promise<void> {
    const r = await this.remote.exec(['systemctl', '--user', 'stop', VM_UNIT]);
    if (r.code === 0) return;
    const state = await this.vmActive();
    if (state === 'active' || state === 'activating' || state === 'deactivating') {
      throw new Error(
        `systemctl --user stop ${VM_UNIT} failed (exit ${r.code}): ${tail(r.stderr)}`,
      );
    }
  }

  async vmStart(): Promise<void> {
    await this.exec(['systemctl', '--user', 'start', VM_UNIT], `starting ${VM_UNIT}`);
  }

  async vmClock(): Promise<string> {
    const out = (
      await this.exec(['date', '-u', '+%Y-%m-%dT%H:%M:%SZ'], 'reading the VM clock')
    ).trim();
    if (Number.isNaN(Date.parse(out))) throw new Error(`unparseable VM clock: ${out}`);
    return out;
  }

  async pollUntil(fn: () => Promise<boolean>, timeoutMs: number, pollMs: number): Promise<boolean> {
    let waited = 0;
    for (;;) {
      if (await fn()) return true;
      if (waited >= timeoutMs) return false;
      await this.sleep(pollMs);
      waited += pollMs;
    }
  }

  async doctorOk(
    r: { code: number; stdout: string; stderr: string },
    where: string,
  ): Promise<void> {
    // doctor exits 0 ok / 1 warnings / 2 failures; warnings are expected on Linux.
    let fails: string[] | null = null;
    try {
      const rep = JSON.parse(r.stdout) as {
        summary?: { fail?: number };
        checks?: Array<{ name: string; status: string; severity?: string }>;
      };
      if (typeof rep.summary?.fail === 'number' && rep.summary.fail > 0) {
        fails = (rep.checks ?? [])
          .filter((c) => c.status !== 'ok' && c.severity === 'critical')
          .map((c) => c.name);
        if (fails.length === 0) fails = [`${rep.summary.fail} check(s)`];
      }
    } catch {
      throw new Error(`${where} doctor printed no JSON report (exit ${r.code}): ${tail(r.stderr)}`);
    }
    if (r.code === 2 || fails) {
      throw new Error(
        `${where} doctor reports failures: ${(fails ?? ['see robin doctor']).join(', ')}`,
      );
    }
    if (r.code !== 0 && r.code !== 1) {
      throw new Error(`${where} doctor exited ${r.code}: ${tail(r.stderr)}`);
    }
  }

  // --- Mac quiescence ---

  /** In-flight work after the pause: Robin's children plus the daemon's own leased jobs. */
  async macInFlight(): Promise<Proc[]> {
    const out = [...(await this.macProcs.children())];
    const n = this.macLeased();
    if (n > 0) out.push({ pid: 0, cmd: `${n} job(s) still leased by the daemon itself` });
    return out;
  }

  async macAllHolders(): Promise<Proc[]> {
    const seen = new Map<number, Proc>();
    for (const p of await this.macProcs.children()) seen.set(p.pid, p);
    for (const p of await this.macProcs.dbHolders(this.macDb)) seen.set(p.pid, p);
    const out = [...seen.values()];
    if (out.length === 0 && this.heldOpen(this.macDb)) {
      out.push({ pid: 0, cmd: `an unidentified process holds ${this.macDb} open` });
    }
    return out;
  }

  async wait(
    list: () => Promise<Proc[]>,
    timeoutMs: number,
    what: string,
    advice: string,
  ): Promise<void> {
    let last = '';
    const r = await waitQuiescent(list, {
      timeoutMs,
      pollMs: this.timing.pollMs,
      sleep: this.sleep,
      onWait: (procs) => {
        const key = procs.map((p) => p.pid).join(',');
        if (key === last) return;
        last = key;
        this.detail(`waiting on ${what} (up to ${Math.round(timeoutMs / 60_000)} min):`);
        for (const p of procs) this.detail(`  ${p.pid} ${p.cmd}`);
      },
    });
    if (!r.ok) {
      const names = r.remaining.map((p) => `${p.pid} ${p.cmd}`).join('; ');
      throw new Error(
        `${what} still running after ${Math.round(timeoutMs / 60_000)} min: ${names}. ${advice}`,
      );
    }
  }

  // --- VM quiescence ---

  async vmCgroupProcs(cg: string): Promise<Proc[]> {
    const [, cat] = cgroupProcsArgv(cg);
    const r = await this.remote.exec(cat);
    if (r.code !== 0) {
      if (/no such file/i.test(r.stderr)) return []; // the cgroup is gone: nothing left in it
      throw new Error(`reading ${cat[1]} failed (exit ${r.code}): ${tail(r.stderr)}`);
    }
    const pids = r.stdout
      .split('\n')
      .map((l) => Number(l.trim()))
      .filter((p) => Number.isInteger(p) && p > 0);
    if (pids.length === 0) return [];
    const ps = await this.remote.exec(['ps', '-o', 'pid=,args=', '-p', pids.join(',')]);
    const names = new Map(parsePs(ps.stdout).map((p) => [p.pid, p.cmd]));
    return pids.map((pid) => ({ pid, cmd: names.get(pid) ?? '(exited)' }));
  }

  async vmMainPid(): Promise<number> {
    const out = await this.exec(
      ['systemctl', '--user', 'show', '-p', 'MainPID', '--value', VM_UNIT],
      'reading MainPID',
    );
    const n = Number(out.trim());
    return Number.isInteger(n) && n > 0 ? n : 0;
  }
}

/**
 * A data rollback in progress, recorded on the Mac before the VM is held. The
 * VM's role says `vm-dry-run` from the rollback's first remote step on, which
 * alone would read as "never became primary"; this record keeps a re-run on
 * the data path. It is bound to the lock it was taken under (`lockAt`), so a
 * leftover from an older lock is ignored. It also keeps the VM cgroup a re-run
 * must still check after the daemon stopped (an inactive unit reports none).
 */
interface RollbackRecord {
  host: string;
  lockAt: string;
  controlGroup?: string;
}

export const rollbackRecordPath = (userData: string) =>
  join(userData, 'state', 'runtime', 'cloud-rollback.json');

export function readRollbackInProgress(
  userData: string,
  local: CloudRoleRecord | null,
  host: string,
): RollbackRecord | null {
  if (local?.role !== 'mac-locked' || local.host !== host) return null;
  const path = rollbackRecordPath(userData);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  // Present but unreadable could hide a rollback in progress: never read it as absent.
  let r: RollbackRecord;
  try {
    r = JSON.parse(text) as RollbackRecord;
    if (typeof r?.host !== 'string' || typeof r.lockAt !== 'string') throw new Error('shape');
    if (r.controlGroup !== undefined) validControlGroup(r.controlGroup);
  } catch {
    throw new Error(`the rollback record ${path} is unreadable; fix or remove it by hand`);
  }
  // A record from another host or an older lock is a leftover, not this lock's rollback.
  return r.host === host && r.lockAt === local.at ? r : null;
}

/** tmp + rename, like writeRole: a crash never leaves a half-written record. */
function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value)}\n`);
  renameSync(tmp, path);
}

function writeRollbackRecord(userData: string, rec: RollbackRecord): void {
  writeJsonAtomic(rollbackRecordPath(userData), rec);
}

/**
 * Written on the Mac right before a cutover resumes the VM as primary: from
 * then on the VM may have rotated WHOOP's token, so an unlock-only rollback
 * (which keeps the Mac's own DB) needs --accept-token-reset. A data rollback
 * brings the token home and drops it.
 */
export const vmRanPath = (userData: string) =>
  join(userData, 'state', 'runtime', 'cloud-vm-ran.json');

/**
 * One `robin cloud` operation at a time on this Mac (O_EXCL). A live holder or a
 * stale lock both refuse; a stale lock is never removed automatically.
 */
export const opLockPath = (userData: string) => join(userData, 'state', 'runtime', 'cloud-op.lock');

const defaultPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
};

function acquireOpLock(
  userData: string,
  cmd: CloudCmd,
  startedAt: string,
  pidAlive: (pid: number) => boolean,
): { release: () => void } | { refusal: string } {
  const path = opLockPath(userData);
  mkdirSync(dirname(path), { recursive: true });
  const token = randomBytes(8).toString('hex');
  const body = `${JSON.stringify({ pid: process.pid, command: cmd, startedAt, token })}\n`;
  try {
    const fd = openSync(path, 'wx', 0o600);
    try {
      writeSync(fd, body);
    } finally {
      closeSync(fd);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    let held: { pid?: unknown; command?: unknown; startedAt?: unknown } = {};
    try {
      held = JSON.parse(readFileSync(path, 'utf8')) as typeof held;
    } catch {
      /* unreadable: reported as stale below */
    }
    const pid = typeof held.pid === 'number' ? held.pid : 0;
    const what = typeof held.command === 'string' ? held.command : '?';
    if (pid > 0 && pidAlive(pid)) {
      return { refusal: `another robin cloud ${what} is running (pid ${pid})` };
    }
    return {
      refusal: `stale lock from pid ${pid || '?'} (${what}, ${String(held.startedAt ?? '?')}) — check robin cloud status, then delete ${path}`,
    };
  }
  return {
    release: () => {
      try {
        if (readFileSync(path, 'utf8') === body) rmSync(path, { force: true });
      } catch {
        /* already gone */
      }
    },
  };
}

function dropRollbackRecord(userData: string): void {
  rmSync(rollbackRecordPath(userData), { force: true });
}

interface Step {
  title: string;
  run: () => Promise<void> | void;
}

async function runSteps(
  c: Ctx,
  steps: Step[],
  opts: {
    onFail?: (index: number) => Promise<void>;
    hint?: (index: number) => string | undefined;
  } = {},
): Promise<number> {
  for (const [i, step] of steps.entries()) {
    if (c.aborted !== null) return c.aborted;
    c.current = `[${i + 1}/${steps.length}] ${step.title}`;
    c.log(c.current);
    try {
      await step.run();
      if (c.aborted !== null) return c.aborted;
      c.log('      ok');
    } catch (err) {
      if (c.aborted !== null) return c.aborted;
      c.log(`      FAILED: ${(err as Error).message}`);
      await opts.onFail?.(i);
      c.log(
        opts.hint?.(i) ?? `Fix the problem and re-run: robin cloud ${c.cmd} --host ${c.o.host}`,
      );
      return 1;
    }
  }
  return 0;
}

const describeRole = (r: CloudRoleRecord | null) =>
  r ? `${r.role}${r.host ? ` (host ${r.host})` : ''}` : 'none';

export async function runCloud(cmd: CloudCmd, opts: RunCloudOpts): Promise<number> {
  const log = opts.log ?? defaultLog;
  const needsConfirm = cmd === 'cutover' || cmd === 'rollback';
  const prompt = opts.prompt === undefined ? (process.stdin.isTTY ? ttyPrompt : null) : opts.prompt;
  if (needsConfirm && !opts.yes && !prompt) {
    log(`robin cloud ${cmd} needs confirmation: pass --yes, or run it from a terminal.`);
    return 1;
  }

  let c: Ctx;
  try {
    c = new Ctx(cmd, opts);
  } catch (err) {
    log(`robin cloud ${cmd}: ${(err as Error).message}`);
    return 1;
  }
  if (cmd === 'status') {
    try {
      return await status(c);
    } finally {
      c.cleanup();
    }
  }
  const lock = acquireOpLock(
    opts.userData,
    cmd,
    c.now().toISOString(),
    opts.pidAlive ?? defaultPidAlive,
  );
  if ('refusal' in lock) {
    log(`Refusing robin cloud ${cmd}: ${lock.refusal}`);
    return 1;
  }
  // Ctrl-C / SIGTERM skip `finally`: release our lock and stop where we are —
  // never run another step. (A hard kill still leaves a stale lock.)
  const signals = opts.signals ?? processSignals;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const handlers = (['SIGINT', 'SIGTERM'] as const).map((sig) => {
    const handler = () => {
      if (c.aborted !== null) return;
      const code = sig === 'SIGINT' ? 130 : 143;
      c.aborted = code;
      lock.release();
      c.cleanup();
      log('');
      log(
        `Interrupted (${sig}) ${c.current ? `during ${c.current}` : 'before the first step'}; no further steps run.`,
      );
      log(`Check where things stand: robin cloud status --host ${opts.host}`);
      exit(code);
    };
    signals.on(sig, handler);
    return [sig, handler] as const;
  });
  try {
    let remoteRole: CloudRoleRecord | null;
    try {
      await c.connect();
      remoteRole = await c.remoteRole();
    } catch (err) {
      log(`robin cloud ${cmd}: ${(err as Error).message}`);
      return 1;
    }
    const local = readRole(opts.userData);
    let rollingBack: RollbackRecord | null;
    try {
      rollingBack = readRollbackInProgress(opts.userData, local, opts.host);
    } catch (err) {
      log(`Refusing robin cloud ${cmd}: ${(err as Error).message}`);
      return 1;
    }
    const allowed = allowedCommands(local, remoteRole?.role ?? null, opts.host, !!rollingBack);
    if (!allowed.includes(cmd)) {
      log(`Refusing robin cloud ${cmd} in the current state:`);
      log(`  Mac: ${describeRole(local)}`);
      log(`  VM (${opts.host}): ${describeRole(remoteRole)}`);
      if (rollingBack)
        log('  a data rollback is in progress — finish it with robin cloud rollback');
      log(`Allowed now: ${allowed.join(', ')}`);
      return 1;
    }

    if (needsConfirm && !opts.yes && prompt) {
      const answer = await prompt(`Type "${cmd}" to continue: `);
      if (answer.trim() !== cmd) {
        log('Not confirmed; nothing changed.');
        return 1;
      }
    }

    if (cmd === 'dry-run') return await dryRun(c);
    if (cmd === 'cutover') return await cutover(c, local);
    return remoteRole?.role === 'vm-primary' || rollingBack
      ? await rollback(c, local as CloudRoleRecord, rollingBack)
      : await unlockOnly(c);
  } finally {
    for (const [sig, handler] of handlers) signals.off(sig, handler);
    c.cleanup();
    lock.release();
  }
}

// ---------------------------------------------------------------------------
// Commands

async function status(c: Ctx): Promise<number> {
  const local = readRole(c.o.userData);
  let remote: CloudRoleRecord | null = null;
  let remoteErr: string | null = null;
  let remoteHealth = 'unknown';
  try {
    await c.connect();
    remote = await c.remoteRole();
    const h = await c.remote.exec(['curl', '-fs', '--max-time', '3', HEALTH_URL]);
    remoteHealth = h.code === 0 ? 'up' : 'down';
  } catch (err) {
    remoteErr = (err as Error).message;
  }
  let rollingBack: RollbackRecord | null = null;
  let recordErr: string | null = null;
  try {
    rollingBack = readRollbackInProgress(c.o.userData, local, c.o.host);
  } catch (err) {
    recordErr = (err as Error).message;
  }
  const lh = await c.run('curl', ['-fs', '--max-time', '3', HEALTH_URL]);
  c.log(`Mac: ${describeRole(local)} — daemon ${lh.code === 0 ? 'up' : 'down'}`);
  c.log(
    remoteErr
      ? `VM (${c.o.host}): unknown — ${remoteErr}`
      : `VM (${c.o.host}): ${describeRole(remote)} — daemon ${remoteHealth}`,
  );
  const lr = local?.role ?? null;
  const rr = remoteErr ? 'unknown' : (remote?.role ?? null);
  let writer: string;
  if (lr === null && rr === 'vm-primary')
    writer = 'BOTH — the Mac is unlocked and the VM is primary';
  else if (lr === null) writer = 'this Mac';
  else if (lr === 'mac-locked' && rr === 'vm-primary') writer = `the VM (${c.o.host})`;
  else if (lr === 'mac-locked' && rr !== 'unknown') {
    writer = 'nobody — cutover incomplete (Mac locked, VM held); re-run cutover or rollback';
  } else writer = 'unknown';
  c.log(`Writer: ${writer}`);
  if (rollingBack) c.log('A data rollback is in progress: finish it with robin cloud rollback.');
  if (recordErr) c.log(recordErr);
  if (lr === null && lh.code !== 0) {
    c.log('This Mac is unlocked but its daemon is down. Start it:');
    for (const line of startByHandLines()) c.log(line);
  }
  if (!remoteErr)
    c.log(
      `Allowed now: ${allowedCommands(local, remote?.role ?? null, c.o.host, !!rollingBack).join(', ')}`,
    );
  return 0;
}

/** Preflight shared by every command but status (`connect` already proved ssh). */
async function preflight(c: Ctx): Promise<void> {
  const lh = await c.run('git', ['-C', c.o.repoRoot, 'rev-parse', 'HEAD']);
  if (lh.code !== 0) throw new Error(`git rev-parse on this Mac failed: ${tail(lh.stderr)}`);
  c.macHead = lh.stdout.trim();
  const rh = await c.remote.exec(['git', '-C', c.vm.repo, 'rev-parse', 'HEAD']);
  if (rh.code !== 0) throw new Error(`no checkout at ${c.vm.repo} on the VM: ${tail(rh.stderr)}`);
  const vmHead = rh.stdout.trim();
  if (vmHead !== c.macHead) {
    throw new Error(
      `commit mismatch: Mac ${c.macHead.slice(0, 12)}, VM ${vmHead.slice(0, 12)} — check out the same commit on the VM and pnpm build`,
    );
  }
  c.detail(`commit ${c.macHead.slice(0, 12)} on both sides`);
  const st = await c.remote.exec(['test', '-f', `${c.vm.repo}/dist/.build-stamp`]);
  if (st.code !== 0)
    throw new Error(`the VM has no dist/.build-stamp — run pnpm build in ${c.vm.repo}`);

  c.rsync = await resolveRsync(c);
  c.detail(`rsync: ${c.rsync}`);

  // Rollback writes one thing on the VM (a snapshot of its DB); a push needs
  // room for the transfer twice over.
  const need = c.cmd === 'rollback' ? await vmDbBytes(c) : 2 * (await transferEstimate(c));
  const df = await c.exec(['df', '-Pk', c.vm.repo], 'df');
  const availKb = Number(df.trim().split('\n')[1]?.trim().split(/\s+/)[3]);
  if (!Number.isFinite(availKb)) throw new Error(`unparseable df output: ${tail(df)}`);
  const free = availKb * 1024;
  if (free < need) {
    throw new Error(
      c.cmd === 'rollback'
        ? `the VM has ${gb(free)} free disk; the rollback's snapshot of its DB needs ${gb(need)}`
        : `the VM has ${gb(free)} free disk; the move needs ${gb(need)} (2× the transfer)`,
    );
  }
  c.detail(`VM disk: ${gb(free)} free, ${gb(need)} needed`);
  if (c.cmd === 'rollback') await macDiskForRollback(c);
  if (c.cmd === 'cutover') {
    // auto-land's probation kickstarts the daemon: under the lock it would exit
    // at start, and the probation would revert a good land.
    const probation = (await c.macProcs.children()).filter((p) => p.cmd.includes('land-probation'));
    if (probation.length > 0) {
      throw new Error(
        `an auto-land probation is running (${probation.map((p) => `pid ${p.pid}`).join(', ')}); its daemon restart would hit the locked Mac and revert the land — wait for it to finish (about 150 s), then re-run`,
      );
    }
  }
  c.detail(`VM daemon: ${await c.vmActive()}`);
}

/** The VM DB's size (file + -wal): what one snapshot of it takes. */
async function vmDbBytes(c: Ctx): Promise<number> {
  // du exits 1 for a missing -wal but still prints the total of what exists.
  const r = await c.remote.exec(['du', '-skc', c.vm.db, `${c.vm.db}-wal`]);
  const last = r.stdout.trim().split('\n').pop() ?? '';
  const kb = Number(last.trim().split(/\s+/)[0]);
  if (last.trim() === '' || !Number.isFinite(kb)) {
    throw new Error(`du ${c.vm.db} failed on the VM (exit ${r.code}): ${tail(r.stderr)}`);
  }
  return kb * 1024;
}

/**
 * Refuse to pass a point of no return if this Mac's checkout moved since
 * preflight (a commit or an auto-land landed mid-run): the VM runs the commit
 * preflight checked, and a later rollback refuses on a mismatch.
 */
async function assertHeadUnchanged(c: Ctx): Promise<void> {
  const r = await c.run('git', ['-C', c.o.repoRoot, 'rev-parse', 'HEAD']);
  const head = r.code === 0 ? r.stdout.trim() : '';
  if (head !== c.macHead) {
    const was = c.macHead.slice(0, 12);
    throw new Error(
      `this Mac's checkout moved during the run (HEAD now ${head.slice(0, 12) || 'unreadable'}, preflight checked ${was}); refusing to continue — check out ${was} again (or put both sides on the new commit and pnpm build), then re-run`,
    );
  }
}

/** The Mac must hold the VM's user-data (backups/ is never pulled) twice over. */
async function macDiskForRollback(c: Ctx): Promise<void> {
  const duKb = async (path: string, required: boolean): Promise<number> => {
    const r = await c.remote.exec(['du', '-sk', path]);
    const kb = Number(r.stdout.trim().split(/\s+/)[0]);
    if (Number.isFinite(kb) && r.stdout.trim() !== '') return kb;
    if (required)
      throw new Error(`du ${path} failed on the VM (exit ${r.code}): ${tail(r.stderr)}`);
    return 0;
  };
  const vmBytes =
    Math.max(0, (await duKb(c.vm.userData, true)) - (await duKb(c.vm.backups, false))) * 1024;
  const df = await c.run('df', ['-Pk', c.o.userData]);
  const availKb = Number(df.stdout.trim().split('\n')[1]?.trim().split(/\s+/)[3]);
  if (df.code !== 0 || !Number.isFinite(availKb)) {
    throw new Error(`df on this Mac failed (exit ${df.code}): ${tail(df.stderr)}`);
  }
  const free = availKb * 1024;
  const need = 2 * vmBytes;
  if (free < need) {
    throw new Error(
      `this Mac has ${gb(free)} free disk; bringing the VM's data home needs ${gb(need)} (2× the VM's user-data)`,
    );
  }
  c.detail(`Mac disk: ${gb(free)} free, ${gb(need)} needed`);
}

/**
 * Where a rollback's user-data pull keeps the Mac files it overwrites: beside
 * user-data, always absolute (rsync resolves a relative --backup-dir against
 * the destination, which would put it inside user-data).
 */
export function rollbackBackupDir(userData: string, stamp: string): string {
  const ud = resolve(userData);
  return join(dirname(ud), `${basename(ud)}.pre-rollback-${stamp}`);
}

/** Refuse to pass a point of no return if this run's lock is no longer the Mac's lock. */
function assertStillLocked(c: Ctx): void {
  const r = readRole(c.o.userData);
  if (r?.role !== 'mac-locked' || r.host !== c.o.host || r.at !== c.lockAt) {
    throw new Error(
      `this Mac's lock changed during the run (now: ${describeRole(r)}); refusing to continue`,
    );
  }
}

const gb = (n: number) => `${(n / 1024 ** 3).toFixed(1)} GB`;

async function resolveRsync(c: Ctx): Promise<string> {
  for (const bin of ['/opt/homebrew/bin/rsync', '/usr/local/bin/rsync', 'rsync']) {
    const r = await c.run(bin, ['--version']);
    if (r.code !== 0) continue;
    const v = parseRsyncVersion(r.stdout);
    if (v.gnu && v.major >= 3) return bin;
  }
  throw new Error(
    'GNU rsync ≥ 3 not found (macOS /usr/bin/rsync is openrsync, which lacks --info=progress2): brew install rsync',
  );
}

/** user-data bytes rsync would move (excludes applied) plus the DB. */
async function transferEstimate(c: Ctx): Promise<number> {
  const empty = mkdtempSync(join(c.tmpDir(), 'estimate-'));
  const r = await c.run(c.rsync as string, [
    '-an',
    '--stats',
    ...MOVE_EXCLUDES.map((p) => `--exclude=${p}`),
    `${c.o.userData.replace(/\/$/, '')}/`,
    `${empty}/`,
  ]);
  if (r.code !== 0) throw new Error(`rsync --stats failed (exit ${r.code}): ${tail(r.stderr)}`);
  const m = /Total file size: ([\d,.]+) bytes/.exec(r.stdout);
  if (!m) throw new Error('could not size user-data (rsync --stats printed no total)');
  let db = 0;
  for (const s of ['', '-wal']) if (existsSync(c.macDb + s)) db += statSync(c.macDb + s).size;
  return Number(m[1].replace(/[,.]/g, '')) + db;
}

/** Snapshot + scrub: the file that crosses to the VM never carries Mac-only rows. */
function snapshotSteps(c: Ctx, out: { snap: string; events: number }): Step[] {
  return [
    {
      title: 'snapshot the Mac DB',
      run: () => {
        out.snap = join(c.tmpDir(), 'robin.sqlite');
        c.db.snapshot(c.o.userData, out.snap);
        c.detail(`${gb(statSync(out.snap).size)} → ${out.snap}`);
      },
    },
    {
      title: 'scrub Mac-only rows from the snapshot',
      run: () => {
        const r = c.db.scrub(out.snap, { liveDbPath: c.macDb });
        out.events = countEvents(out.snap);
        c.detail(
          `removed ${r.removed} events and ${r.derived} derived rows; ${out.events} events left`,
        );
      },
    },
  ];
}

/** Land the snapshot as the VM's DB: push beside it, then swap in one rename. */
async function installSnapshotOnVm(c: Ctx, snap: string, carryTokens: boolean): Promise<void> {
  await c.exec(['mkdir', '-p', c.vm.dbDir], 'mkdir state/db');
  await c.remote.pushFile(snap, `${c.vm.db}.incoming`);
  if (carryTokens) {
    // A parked earlier cutover may have let the VM rotate an OAuth token; the
    // newer row wins so a re-run never ships a spent refresh token.
    const n = Number(await c.vmDb('carry-oauth', c.vm.db, `${c.vm.db}.incoming`));
    if (n > 0) c.detail(`kept ${n} newer OAuth token row(s) from the VM's DB`);
  }
  if ((await c.vmDb('held', c.vm.db)) !== 'free') {
    throw new Error(`${c.vm.db} is open in another process on the VM`);
  }
  await c.exec(['sh', '-c', DB_INSTALL_SH, 'sh', c.vm.db], 'installing the DB');
}

async function verifyVmUp(c: Ctx): Promise<void> {
  const up = await c.pollUntil(
    async () => (await c.remote.exec(['curl', '-fs', '--max-time', '3', HEALTH_URL])).code === 0,
    c.timing.healthMs,
    3_000,
  );
  if (!up) throw new Error(`the VM's /health did not answer within ${c.timing.healthMs / 1000} s`);
  c.detail('/health ok');
  await c.doctorOk(await c.remote.exec(remoteCliArgv(c.vm.repo, ['doctor', '--json'])), 'VM');
  c.detail('doctor: no failures');
}

async function dryRun(c: Ctx): Promise<number> {
  const snap = { snap: '', events: 0 };
  return runSteps(c, [
    { title: 'preflight', run: () => preflight(c) },
    ...snapshotSteps(c, snap),
    { title: 'stop the VM daemon', run: () => c.vmStop() },
    // Held before any data lands, so a VM reboot mid-transfer can't tick the copied tokens.
    { title: 'hold the VM (role vm-dry-run)', run: () => c.writeRemoteRole('vm-dry-run') },
    {
      title: 'push user-data',
      run: () => c.remote.push(c.o.userData, c.vm.userData, MOVE_EXCLUDES),
    },
    { title: 'push the DB snapshot', run: () => installSnapshotOnVm(c, snap.snap, false) },
    { title: 'start the VM daemon (held)', run: () => c.vmStart() },
    {
      title: 'verify the VM',
      run: async () => {
        await verifyVmUp(c);
        const vmEvents = Number(await c.vmDb('count', c.vm.db));
        c.detail(`snapshot events: ${snap.events}   VM events: ${vmEvents}`);
        c.detail('(the live Mac keeps writing, so compare against the snapshot)');
      },
    },
  ]).then((code) => {
    if (code === 0) {
      c.log('Dry run done. The VM serves a held copy; this Mac is still the writer.');
      c.log(`Repeat any time; when ready: robin cloud cutover --host ${c.o.host}`);
    }
    return code;
  });
}

function settingsGaps(path: string): string[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return [];
  }
  const hooks = (raw as { hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>> })
    ?.hooks;
  const hits: string[] = [];
  for (const [event, groups] of Object.entries(hooks ?? {})) {
    for (const g of Array.isArray(groups) ? groups : []) {
      for (const h of g.hooks ?? []) {
        if (typeof h.command === 'string' && /(127\.0\.0\.1|localhost):41273/.test(h.command)) {
          hits.push(event);
        }
      }
    }
  }
  return [...new Set(hits)];
}

async function gapsGate(c: Ctx): Promise<void> {
  const gaps: string[] = [];
  const settings = c.o.claudeSettingsPath ?? join(homedir(), '.claude', 'settings.json');
  const hooked = settingsGaps(settings);
  if (hooked.length > 0) {
    gaps.push(
      `${settings} hooks (${hooked.join(', ')}) still post to 127.0.0.1:41273 — Mac session capture and recall fail silently after cutover (M5)`,
    );
  }
  const timers = await c.remote.exec([
    'systemctl',
    '--user',
    'list-unit-files',
    '--type=timer',
    '--no-legend',
  ]);
  if (timers.code !== 0 || !/backup\S*\.timer/i.test(timers.stdout)) {
    gaps.push('the VM has no backup timer — nothing backs up the VM DB yet (M5)');
  }
  if (gaps.length === 0) return;
  for (const g of gaps) c.detail(`gap: ${g}`);
  if (!c.o.acceptGaps)
    throw new Error(`${gaps.length} known gap(s); re-run with --accept-gaps to accept them`);
  c.detail('accepted (--accept-gaps)');
}

async function cutover(c: Ctx, existing: CloudRoleRecord | null): Promise<number> {
  const snap = { snap: '', events: 0 };
  let since = '';
  const steps: Step[] = [
    { title: 'preflight', run: () => preflight(c) },
    { title: 'check known gaps', run: () => gapsGate(c) },
    {
      title: 'lock this Mac (role mac-locked)',
      run: () => {
        if (existing?.role === 'mac-locked' && existing.host === c.o.host) {
          c.detail(`already locked since ${existing.at} (resuming)`);
          c.lockAt = existing.at;
          return;
        }
        dropRollbackRecord(c.o.userData);
        rmSync(vmRanPath(c.o.userData), { force: true });
        c.lockAt = c.now().toISOString();
        writeRole(c.o.userData, {
          role: 'mac-locked',
          host: c.o.host,
          at: c.lockAt,
          commit: c.macHead,
        });
      },
    },
    { title: 'pause this Mac', run: () => c.power(c.o.userData, 'paused') },
    {
      title: 'drain in-flight work on this Mac',
      run: () =>
        c.wait(
          () => c.macInFlight(),
          c.timing.drainMs,
          "Robin's agent/cognition runs and in-process jobs",
          'Wait for them to finish (or stop them), then re-run.',
        ),
    },
    { title: 'stop the Mac services (daemon, mcp-remote)', run: () => c.service.stopMac() },
    { title: 'disable the Mac services', run: () => c.service.disableMac() },
    {
      title: 'confirm nothing holds the Mac DB',
      run: () =>
        c.wait(
          () => c.macAllHolders(),
          c.timing.quiesceMs,
          'processes holding the Mac DB',
          'Close these Claude Code sessions (their Robin MCP servers hold the DB), then re-run.',
        ),
    },
    ...snapshotSteps(c, snap),
    { title: 'stop the VM daemon', run: () => c.vmStop() },
    { title: 'hold the VM (role vm-dry-run)', run: () => c.writeRemoteRole('vm-dry-run') },
    {
      title: "clear the VM's runtime state",
      run: async () => {
        await c.exec(['mkdir', '-p', c.vm.runtime], 'mkdir state/runtime');
        await c.exec(
          [
            'find',
            c.vm.runtime,
            '-mindepth',
            '1',
            '-maxdepth',
            '1',
            '!',
            '-name',
            'cloud-role.json',
            '-exec',
            'rm',
            '-rf',
            '--',
            '{}',
            '+',
          ],
          'clearing state/runtime',
        );
      },
    },
    {
      title: 'push user-data',
      run: () => c.remote.push(c.o.userData, c.vm.userData, MOVE_EXCLUDES),
    },
    { title: 'push the DB snapshot', run: () => installSnapshotOnVm(c, snap.snap, true) },
    {
      title: 'mark the VM primary',
      run: async () => {
        assertStillLocked(c);
        await assertHeadUnchanged(c);
        await c.writeRemoteRole('vm-primary');
      },
    },
    {
      title: 'start the VM daemon',
      run: async () => {
        since = await c.vmClock();
        await c.vmStart();
      },
    },
    {
      title: 'resume the VM',
      run: async () => {
        // From here the VM may rotate WHOOP's token: remember it for an unlock-only rollback.
        writeJsonAtomic(vmRanPath(c.o.userData), {
          host: c.o.host,
          at: c.now().toISOString(),
          lockAt: c.lockAt,
        });
        await c.cli(['resume'], 'robin resume');
      },
    },
    {
      title: 'verify the VM',
      run: async () => {
        await verifyVmUp(c);
        c.detail(
          `waiting for a job or integration run after ${since} (up to ${c.timing.activityMs / 60_000} min)`,
        );
        const ran = await c.pollUntil(
          async () => {
            const a = JSON.parse(await c.vmDb('activity', c.vm.db, since)) as {
              jobs: number;
              integrations: number;
            };
            return a.jobs + a.integrations > 0;
          },
          c.timing.activityMs,
          30_000,
        );
        if (!ran) {
          throw new Error(
            `no job or integration ran on the VM within ${c.timing.activityMs / 60_000} min`,
          );
        }
        c.detail('the VM scheduler is running work');
      },
    },
  ];
  const markIdx = steps.findIndex((s) => s.title === 'mark the VM primary');
  const code = await runSteps(c, steps, {
    onFail: async (i) => {
      if (i < markIdx) return;
      // Park: hold first (the role is read live, so the scheduler stops at once), then stop.
      c.log('      parking the VM: role vm-dry-run, daemon stopped; this Mac stays locked');
      try {
        await c.writeRemoteRole('vm-dry-run');
        await c.vmStop();
      } catch (err) {
        c.log(`      COULD NOT PARK THE VM: ${(err as Error).message}`);
        c.log(`      On ${c.o.host}, run: systemctl --user stop ${VM_UNIT}`);
      }
    },
  });
  if (code === 0) {
    c.log('');
    c.log(`Robin now runs on ${c.o.host}. This Mac is locked (robin cloud status).`);
    c.log('Next:');
    c.log(`  - ssh ${c.o.host}, then: journalctl --user -u ${VM_UNIT} -f`);
    c.log('  - Mac Claude Code sessions have no Robin MCP tools until M5 points them at the VM.');
    c.log(`  - To move back: robin cloud rollback --host ${c.o.host}`);
  }
  return code;
}

async function rollback(
  c: Ctx,
  lock: CloudRoleRecord,
  resumed: RollbackRecord | null,
): Promise<number> {
  let cg = '';
  let remoteSnap = '';
  const incoming = join(dirname(c.macDb), 'cloud-rollback-incoming.sqlite');
  const record: RollbackRecord = resumed ?? { host: c.o.host, lockAt: lock.at };
  c.lockAt = lock.at;
  const backupDir = rollbackBackupDir(c.o.userData, c.stamp());
  const steps: Step[] = [
    { title: 'preflight', run: () => preflight(c) },
    {
      title: 'record the rollback on this Mac',
      run: () => {
        if (resumed) c.detail('resuming an earlier rollback');
        writeRollbackRecord(c.o.userData, record);
      },
    },
    // Holds integrations in every VM process at once (read live), before anything else.
    { title: 'hold the VM (role vm-dry-run)', run: () => c.writeRemoteRole('vm-dry-run') },
    { title: 'pause the VM', run: () => c.cli(['pause'], 'robin pause').then(() => undefined) },
    {
      title: "find the VM daemon's control group",
      run: async () => {
        // Read while the unit is active: an inactive one reports an empty value.
        const raw = (await c.exec(cgroupProcsArgv()[0], 'reading ControlGroup')).trim();
        if (raw) {
          cg = validControlGroup(raw);
          record.controlGroup = cg;
          writeRollbackRecord(c.o.userData, record);
        } else {
          const saved = record.controlGroup;
          if (!saved) {
            throw new Error(
              `${VM_UNIT} is not active and no earlier run saved its control group; start it on the VM (systemctl --user start ${VM_UNIT} — it is held, so it runs no work) and re-run`,
            );
          }
          cg = saved;
          c.detail('daemon already stopped; using the control group saved by the earlier run');
        }
        c.detail(cg);
      },
    },
    {
      title: 'drain in-flight work on the VM',
      run: () =>
        c.wait(
          async () => {
            const main = await c.vmMainPid();
            const procs = (await c.vmCgroupProcs(cg)).filter((p) => p.pid !== main);
            // A stopped daemon runs no in-process job (its stale leases reset at its next boot).
            if (main > 0) {
              const raw = await c.vmDb('leased', c.vm.db);
              const n = Number(raw);
              if (raw === '' || !Number.isInteger(n)) throw new Error(`VM DB leased: ${raw}`);
              if (n > 0)
                procs.push({ pid: 0, cmd: `${n} job(s) still leased by the VM daemon itself` });
            }
            return procs;
          },
          c.timing.drainMs,
          "the VM daemon's children and in-process jobs",
          'Wait for them to finish (or stop them), then re-run.',
        ),
    },
    { title: 'stop the VM daemon', run: () => c.vmStop() },
    {
      title: 'confirm nothing holds the VM DB',
      run: () =>
        c.wait(
          async () => {
            const procs = await c.vmCgroupProcs(cg);
            if (procs.length === 0 && (await c.vmDb('held', c.vm.db)) !== 'free') {
              procs.push({ pid: 0, cmd: `an unidentified process holds ${c.vm.db} open` });
            }
            return procs;
          },
          c.timing.quiesceMs,
          'processes holding the VM DB',
          'Stop them on the VM, then re-run.',
        ),
    },
    {
      title: 'snapshot the VM DB',
      run: async () => {
        remoteSnap = `${c.vm.backups}/cloud-rollback-${c.stamp()}.sqlite`;
        await c.exec(['mkdir', '-p', c.vm.backups], 'mkdir backups');
        await c.cli(['db', 'backup', `--path=${remoteSnap}`], 'robin db backup');
        c.detail(remoteSnap);
      },
    },
    {
      title: 'pull the VM snapshot',
      run: async () => {
        mkdirSync(dirname(incoming), { recursive: true });
        for (const s of ['-wal', '-shm', '-journal']) rmSync(incoming + s, { force: true });
        await c.remote.pullFile(remoteSnap, incoming);
      },
    },
    {
      title: 'restore Mac-only rows into it',
      run: () => {
        if (!existsSync(c.macDb)) {
          throw new Error(
            `no Mac DB at ${c.macDb} (an earlier one may be in state/db/pre-rollback-*/)`,
          );
        }
        const r = c.db.restore(c.macDb, incoming);
        c.detail(`restored ${r.restored} events, ${r.derived} derived rows (${r.skipped} skipped)`);
      },
    },
    {
      title: 'pull user-data',
      run: async () => {
        // Mac files the pull overwrites are kept beside user-data, never lost.
        await c.remote.pull(c.vm.userData, c.o.userData, MOVE_EXCLUDES, { backupDir });
        c.detail(`overwritten Mac files (if any) kept in ${backupDir}`);
      },
    },
    {
      title: 'confirm nothing holds the Mac DB',
      run: () =>
        c.wait(
          () => c.macAllHolders(),
          c.timing.quiesceMs,
          'processes holding the Mac DB',
          'Close these Claude Code sessions, then re-run.',
        ),
    },
    {
      title: "install the VM's DB on this Mac",
      run: async () => {
        assertStillLocked(c);
        await assertHeadUnchanged(c);
        const aside = join(dirname(c.macDb), `pre-rollback-${c.stamp()}`);
        mkdirSync(aside, { recursive: true });
        for (const s of ['', '-wal', '-shm', '-journal']) {
          if (existsSync(c.macDb + s)) renameSync(c.macDb + s, join(aside, basename(c.macDb) + s));
        }
        renameSync(incoming, c.macDb);
        c.detail(`previous Mac DB kept in ${aside}`);
      },
    },
    // Resume and enable before unlocking: a failure in either leaves the Mac
    // locked (re-runnable), and nothing is left disabled once it is unlocked.
    { title: 'resume this Mac', run: () => c.power(c.o.userData, 'active') },
    { title: 'enable the Mac services', run: () => c.service.enableMac() },
    {
      title: 'unlock this Mac (clear role)',
      run: () => {
        clearRole(c.o.userData);
        dropRollbackRecord(c.o.userData);
        rmSync(vmRanPath(c.o.userData), { force: true });
      },
    },
    { title: 'start the Mac services', run: () => c.service.enableAndStartMac() },
    { title: 'verify this Mac', run: () => verifyMac(c) },
  ];
  const unlockIdx = steps.findIndex((s) => s.title.startsWith('unlock this Mac'));
  const code = await runSteps(c, steps, {
    hint: (i) => (i > unlockIdx ? finishByHand(c) : undefined),
  });
  if (code === 0) {
    c.log('');
    c.log(
      `Robin runs on this Mac again with the VM's data. ${c.o.host} is stopped and held (vm-dry-run).`,
    );
    c.log(`The VM keeps its snapshot at ${remoteSnap}.`);
  }
  return code;
}

async function unlockOnly(c: Ctx): Promise<number> {
  c.log(
    "The VM never became primary: unlocking this Mac only (its own DB stays; the VM's is not pulled).",
  );
  const ran = existsSync(vmRanPath(c.o.userData)); // unreadable counts as present
  const steps: Step[] = [
    {
      title: 'check whether the VM ran as primary',
      run: () => {
        if (!ran) return;
        if (!c.o.acceptTokenReset) {
          throw new Error(
            `the VM ran as primary during the parked cutover: ${TOKEN_WARNING}. Re-run with --accept-token-reset to unlock anyway`,
          );
        }
        c.detail(`${TOKEN_WARNING} (accepted)`);
      },
    },
    { title: 'resume this Mac', run: () => c.power(c.o.userData, 'active') },
    { title: 'enable the Mac services', run: () => c.service.enableMac() },
    {
      title: 'unlock this Mac (clear role)',
      run: () => {
        clearRole(c.o.userData);
        rmSync(vmRanPath(c.o.userData), { force: true });
      },
    },
    { title: 'start the Mac services', run: () => c.service.enableAndStartMac() },
    { title: 'verify this Mac', run: () => verifyMac(c) },
  ];
  const unlockIdx = steps.findIndex((s) => s.title.startsWith('unlock this Mac'));
  const code = await runSteps(c, steps, {
    hint: (i) => (i > unlockIdx ? finishByHand(c) : undefined),
  });
  if (code === 0) {
    c.log('This Mac is the writer again.');
    if (ran) c.log(TOKEN_WARNING);
  }
  return code;
}

const TOKEN_WARNING =
  "WHOOP's token may have rotated on the VM — after unlocking run: robin reauth whoop";

/** Hand commands that enable and load both Mac launchd jobs. */
export function startByHandLines(home?: string): string[] {
  return MAC_SERVICE_LABELS.map(
    (label) =>
      `  launchctl enable gui/$(id -u)/${label} && launchctl bootstrap gui/$(id -u) ${plistPath({ home, label })}`,
  );
}

export function finishByHand(c: { o: { host: string } }): string {
  return [
    'This Mac is already unlocked; robin cloud rollback no longer applies. Finish by hand:',
    ...startByHandLines(),
    '  robin doctor',
    `(the VM ${c.o.host} stays stopped and held)`,
  ].join('\n');
}

async function verifyMac(c: Ctx): Promise<void> {
  const up = await c.pollUntil(
    async () => (await c.run('curl', ['-fs', '--max-time', '3', HEALTH_URL])).code === 0,
    c.timing.healthMs,
    3_000,
  );
  if (!up)
    throw new Error(`this Mac's /health did not answer within ${c.timing.healthMs / 1000} s`);
  c.detail('/health ok');
  const cli = join(c.o.repoRoot, 'dist', 'surfaces', 'cli', 'index.js');
  const r = await c.run('env', [
    `ROBIN_USER_DATA_DIR=${c.o.userData}`,
    process.execPath,
    cli,
    'doctor',
    '--json',
  ]);
  await c.doctorOk(r, 'Mac');
  c.detail('doctor: no failures');
}
