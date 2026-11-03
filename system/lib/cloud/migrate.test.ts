import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { closeDb, openDb } from '../../brain/memory/db.ts';
import { ingest } from '../../brain/memory/ingest.ts';
import { allMigrations, applyMigrations } from '../../brain/memory/migrations/index.ts';
import { loadPolicies } from '../../kernel/config/load.ts';
import { setPowerState } from '../../surfaces/cli/power.ts';
import { LAUNCHD_LABEL } from '../launchd/install.ts';
import { dbFilePath } from '../paths.ts';
import {
  allowedCommands,
  cgroupProcsArgv,
  finishByHand,
  MAC_SERVICE_LABELS,
  macServiceControl,
  opLockPath,
  type Proc,
  parseLsof,
  parsePs,
  parseRsyncVersion,
  type RunCloudOpts,
  remoteCliArgv,
  rollbackRecordPath,
  runCloud,
  type ServiceControl,
  startByHandLines,
  VM_DB_SCRIPT,
  vmRanPath,
  waitQuiescent,
} from './migrate.ts';
import { readRole, writeRole } from './role.ts';
import {
  type ArgvRunner,
  MOVE_EXCLUDES,
  type Remote,
  restoreMacOnlyRows,
  scrubMacOnlyRows,
  snapshotDb,
} from './transfer.ts';

const HOST = 'example-vm';
const HOME = '/home/robin';
const REPO = `${HOME}/robin-assistant-v3`;
const VM_UD = `${REPO}/user-data`;
const VM_DB = `${VM_UD}/state/db/robin.sqlite`;
const CG = '/user.slice/user-1000.slice/user@1000.service/app.slice/robin-daemon.service';
const HEAD = '0123456789abcdef0123456789abcdef01234567';

type Exec = { code: number; stdout: string; stderr: string };
const ok = (stdout = ''): Exec => ({ code: 0, stdout, stderr: '' });
const fail = (code: number, stderr = ''): Exec => ({ code, stdout: '', stderr });

/** A migrated DB with `imessage` (Mac-only) rows and ordinary rows. */
function makeDb(path: string, events: Array<{ source: string; content: string }>): void {
  mkdirSync(join(path, '..'), { recursive: true });
  const db = openDb(path);
  applyMigrations(db, allMigrations);
  for (const [i, e] of events.entries()) {
    ingest(db, null, {
      kind: e.source === 'imessage' ? 'knowledge.archive' : 'knowledge.doc',
      source: e.source,
      content: e.content,
      payload: { n: i, marker: e.content },
    });
  }
  closeDb(db);
}

function countWhere(path: string, sql: string): number {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return (db.prepare(sql).get() as { n: number }).n;
  } finally {
    db.close();
  }
}

/** A fake VM: answers the argv the orchestrator sends and records each effect in `seq`. */
class FakeVm {
  execs: string[][] = [];
  role: Record<string, unknown> | null = null;
  active = true;
  head = HEAD;
  stamp = true;
  freeKb = 50_000_000;
  backupTimer = true;
  healthy = true;
  doctorExit = 1;
  doctorFails = 0;
  activity = true;
  events = 7;
  mainPid = 4242;
  /** Successive `cgroup.procs` answers; the last one repeats. */
  cgroupProcs: number[][] = [[4242]];
  /** The file `pullFile` hands back (the VM's DB snapshot). */
  vmDb: string | null = null;
  pushFails = 0;
  pullFails = 0;
  startFails = 0;
  resumeFails = 0;
  doctorRaw: string | null = null;
  duKb = 2_000;
  backupsKb = 500;
  pullBackupDirs: Array<string | undefined> = [];
  /** Called inside push/pull to simulate a concurrent actor. */
  onTransfer?: (op: 'push' | 'pull' | 'pushFile') => void | Promise<void>;
  /** Mac-only rows found in each file pushed as the DB. */
  pushedImessage: number[] = [];
  constructor(readonly seq: string[]) {}

  private cgPoll = 0;

  exec(argv: string[]): Exec {
    this.execs.push(argv);
    const [cmd, ...rest] = argv;
    const s = this.seq;
    if (cmd === 'true') return ok();
    if (cmd === 'sh' && rest[0] === '-c') {
      const script = rest[1];
      if (script.includes('$HOME')) return ok(HOME);
      if (script.includes('exit 3')) {
        return this.role ? ok(JSON.stringify(this.role)) : fail(3);
      }
      if (script.includes('printf')) {
        this.role = JSON.parse(rest[4]) as Record<string, unknown>;
        s.push(`vm:role ${this.role.role}`);
        return ok();
      }
      if (script.includes('.incoming')) {
        s.push('vm:install-db');
        return ok();
      }
      return fail(99, `unexpected sh script ${script}`);
    }
    if (cmd === 'git') return ok(`${this.head}\n`);
    if (cmd === 'test') return this.stamp ? ok() : fail(1);
    if (cmd === 'df') {
      return ok(
        `Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 80000000 1000 ${this.freeKb} 1% /\n`,
      );
    }
    if (cmd === 'date') return ok('2026-11-02T12:00:00Z\n');
    if (cmd === 'mkdir') return ok();
    if (cmd === 'du') {
      return ok(`${rest[1].endsWith('/backups') ? this.backupsKb : this.duKb}\t${rest[1]}\n`);
    }
    if (cmd === 'find') {
      s.push('vm:clear-runtime');
      return ok();
    }
    if (cmd === 'curl') {
      s.push('vm:health');
      return this.healthy && this.active ? ok('{"ok":true}') : fail(7);
    }
    if (cmd === 'cat') {
      const i = Math.min(this.cgPoll++, this.cgroupProcs.length - 1);
      // a stopped main process leaves the cgroup; its children (if any) stay
      const list = this.cgroupProcs[i].filter((p) => this.active || p !== this.mainPid);
      s.push(`vm:cgroup ${list.join(',')}`);
      return ok(list.map((p) => `${p}\n`).join(''));
    }
    if (cmd === 'ps') {
      return ok(
        rest[rest.length - 1]
          .split(',')
          .map((p) => `${p} node dist/agent/runner-entry.js\n`)
          .join(''),
      );
    }
    if (cmd === 'systemctl') {
      const sub = rest[1];
      if (sub === 'is-active') return this.active ? ok('active\n') : fail(3, 'inactive');
      if (sub === 'stop') {
        s.push('vm:stop');
        this.active = false;
        return ok();
      }
      if (sub === 'start') {
        s.push('vm:start');
        if (this.startFails > 0) {
          this.startFails--;
          return fail(1, 'Job for robin-daemon.service failed');
        }
        this.active = true;
        return ok();
      }
      if (sub === 'list-unit-files') {
        return ok(this.backupTimer ? 'robin-backup.timer enabled enabled\n' : '');
      }
      if (sub === 'show' && rest.includes('ControlGroup'))
        return ok(this.active ? `${CG}\n` : '\n');
      if (sub === 'show' && rest.includes('MainPID')) {
        return ok(`${this.active ? this.mainPid : 0}\n`);
      }
    }
    if (cmd === 'env' && argv.includes('dist/surfaces/cli/index.js')) {
      const i = argv.indexOf('dist/surfaces/cli/index.js');
      const sub = argv[i + 1];
      if (sub === 'doctor') {
        s.push('vm:doctor');
        return {
          code: this.doctorExit,
          stdout:
            this.doctorRaw ?? JSON.stringify({ summary: { fail: this.doctorFails }, checks: [] }),
          stderr: '',
        };
      }
      if (sub === 'resume' && this.resumeFails > 0) {
        this.resumeFails--;
        s.push('vm:resume');
        return fail(1, 'resume boom');
      }
      const words = argv.slice(i + 1).filter((a) => !a.startsWith('--'));
      s.push(`vm:${words.join(' ')}`);
      return ok();
    }
    if (cmd === 'env' && argv.includes('-e')) {
      const mode = argv[argv.indexOf('-e') + 2];
      if (mode === 'count') return ok(`${this.events}\n`);
      if (mode === 'activity') {
        s.push('vm:activity');
        return ok(JSON.stringify({ jobs: this.activity ? 2 : 0, integrations: 0 }));
      }
      if (mode === 'held') return ok('free\n');
      if (mode === 'carry-oauth') {
        s.push('vm:carry-oauth');
        return ok('0\n');
      }
    }
    return fail(99, `fake vm: unexpected ${argv.join(' ')}`);
  }

  remote(): Remote {
    return {
      host: HOST,
      exec: async (argv) => this.exec(argv),
      push: async (_local, remote, excludes) => {
        this.seq.push('vm:push');
        assert.equal(remote, VM_UD);
        assert.deepEqual(excludes, MOVE_EXCLUDES);
        await this.onTransfer?.('push');
        if (this.pushFails > 0) {
          this.pushFails--;
          throw new Error('rsync: connection unexpectedly closed');
        }
      },
      pull: async (remote, _local, excludes, opts) => {
        this.seq.push('vm:pull');
        assert.equal(remote, VM_UD);
        assert.deepEqual(excludes, MOVE_EXCLUDES);
        this.pullBackupDirs.push(opts?.backupDir);
        await this.onTransfer?.('pull');
        if (this.pullFails > 0) {
          this.pullFails--;
          throw new Error('rsync: broken pipe');
        }
      },
      pushFile: async (local, remote) => {
        this.seq.push('vm:pushFile');
        assert.equal(remote, `${VM_DB}.incoming`);
        this.pushedImessage.push(
          countWhere(local, `SELECT count(*) AS n FROM events WHERE source = 'imessage'`),
        );
        await this.onTransfer?.('pushFile');
      },
      pullFile: async (_remote, local) => {
        this.seq.push('vm:pullFile');
        assert.ok(this.vmDb, 'test must set vmDb');
        copyFileSync(this.vmDb, local);
      },
    };
  }
}

interface World {
  userData: string;
  dbPath: string;
  seq: string[];
  vm: FakeVm;
  lines: string[];
  localRuns: Array<{ cmd: string; args: string[] }>;
  children: Proc[][];
  settingsPath: string;
  mac: { healthy: boolean; freeKb: number; doctorRaw: string | null; startFails: number };
  opts(extra?: Partial<RunCloudOpts>): RunCloudOpts;
}

function world(): World {
  const userData = mkdtempSync(join(tmpdir(), 'robin-migrate-'));
  const dbPath = dbFilePath(userData);
  makeDb(dbPath, [
    { source: 'imessage', content: 'archived thread about marzipan' },
    { source: 'imessage', content: 'archived thread about quokka' },
    { source: 'docs', content: 'note about sourdough' },
    { source: 'docs', content: 'note about cadence' },
  ]);
  setPowerState(userData, 'active');
  const seq: string[] = [];
  const vm = new FakeVm(seq);
  const lines: string[] = [];
  const localRuns: Array<{ cmd: string; args: string[] }> = [];
  const children: Proc[][] = [];
  const settingsPath = join(userData, 'claude-settings.json');
  const mac = {
    healthy: true,
    freeKb: 60_000_000,
    doctorRaw: null as string | null,
    startFails: 0,
  };
  const run: ArgvRunner = async (cmd, args) => {
    localRuns.push({ cmd, args });
    if (cmd === 'git') return ok(`${HEAD}\n`);
    if (cmd.endsWith('rsync') && args[0] === '--version') {
      return ok('rsync  version 3.4.1  protocol version 32\n');
    }
    if (cmd.endsWith('rsync')) return ok('Number of files: 10\nTotal file size: 1,000 bytes\n');
    if (cmd === 'curl') {
      seq.push('mac:health');
      return mac.healthy ? ok('{"ok":true}') : fail(7);
    }
    if (cmd === 'env' && args.includes('doctor')) {
      seq.push('mac:doctor');
      return { code: 1, stdout: mac.doctorRaw ?? '{"summary":{"fail":0},"checks":[]}', stderr: '' };
    }
    if (cmd === 'df') {
      return ok(
        `Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk3 1 1 ${mac.freeKb} 1% /\n`,
      );
    }
    return fail(99, `fake mac: unexpected ${cmd} ${args.join(' ')}`);
  };
  const service: ServiceControl = {
    stopMac: async () => {
      seq.push('mac:stopMac');
    },
    disableMac: async () => {
      seq.push('mac:disableMac');
    },
    enableMac: async () => {
      seq.push('mac:enableMac');
      assert.equal(readRole(userData)?.role, 'mac-locked', 'enable runs while still locked');
    },
    enableAndStartMac: async () => {
      seq.push('mac:enableAndStartMac');
      assert.equal(readRole(userData), null, 'the services load only after the unlock');
      if (mac.startFails > 0) {
        mac.startFails--;
        throw new Error('launchctl bootstrap failed (exit 5)');
      }
    },
  };
  return {
    userData,
    dbPath,
    seq,
    vm,
    lines,
    localRuns,
    children,
    settingsPath,
    mac,
    opts: (extra = {}) => ({
      host: HOST,
      userData,
      repoRoot: '/repo',
      remote: vm.remote(),
      service,
      run,
      log: (l) => lines.push(l),
      yes: true,
      prompt: null,
      sleep: async () => {},
      now: () => new Date('2026-11-02T12:00:00Z'),
      claudeSettingsPath: settingsPath,
      tmpRoot: mkdtempSync(join(tmpdir(), 'robin-migrate-tmp-')),
      macProcs: {
        children: async () => {
          seq.push('mac:children');
          return children.length > 1 ? (children.shift() as Proc[]) : (children[0] ?? []);
        },
        dbHolders: async () => [],
      },
      dbHeldOpenElsewhere: () => false,
      power: (u, state) => {
        seq.push(`mac:${state === 'paused' ? 'pause' : 'resume'}`);
        if (state === 'paused') {
          assert.equal(readRole(u)?.role, 'mac-locked', 'the Mac is locked before it is paused');
        }
        setPowerState(u, state);
      },
      dbOps: {
        snapshot: (u, out) => {
          seq.push('mac:snapshot');
          snapshotDb(u, out);
        },
        scrub: (p, o) => {
          seq.push('mac:scrub');
          return scrubMacOnlyRows(p, o);
        },
        restore: (from, into) => {
          seq.push('mac:restore');
          return restoreMacOnlyRows(from, into);
        },
      },
      timing: {
        drainMs: 15_000,
        quiesceMs: 15_000,
        pollMs: 5_000,
        healthMs: 6_000,
        activityMs: 60_000,
      },
      ...extra,
    }),
  };
}

/** `want` appears in `seq` in this order (other entries may sit between). */
function assertSubsequence(seq: string[], want: string[]): void {
  let i = 0;
  for (const s of seq) if (s === want[i]) i++;
  assert.equal(i, want.length, `expected order ${want.join(' → ')}\n   got ${seq.join(' → ')}`);
}

const lock = (w: World) =>
  writeRole(w.userData, { role: 'mac-locked', host: HOST, at: '2026-11-02T11:00:00.000Z' });

const vmRole = (role: string) => ({ role, at: '2026-11-02T11:00:00.000Z' });

// ---------------------------------------------------------------------------

test('cutover order', async () => {
  const w = world();
  w.vm.role = vmRole('vm-dry-run');
  const code = await runCloud('cutover', w.opts());
  assert.equal(code, 0, w.lines.join('\n'));
  assertSubsequence(w.seq, [
    'mac:pause',
    'mac:children',
    'mac:stopMac',
    'mac:disableMac',
    'mac:snapshot',
    'mac:scrub',
    'vm:stop',
    'vm:clear-runtime',
    'vm:push',
    'vm:pushFile',
    'vm:install-db',
    'vm:role vm-primary',
    'vm:start',
    'vm:resume',
    'vm:health',
    'vm:doctor',
    'vm:activity',
  ]);
  const local = readRole(w.userData);
  assert.equal(local?.role, 'mac-locked');
  assert.equal(local?.host, HOST);
  assert.equal(local?.commit, HEAD);
  assert.equal(w.vm.role?.role, 'vm-primary');
  assert.equal(loadPolicies(w.userData).power.state, 'paused');
  // every step reports [n/N] then ok
  const steps = w.lines.filter((l) => /^\[\d+\/\d+\] /.test(l));
  assert.ok(steps.length >= 10);
  assert.equal(w.lines.filter((l) => l.trim() === 'ok').length, steps.length);
});

test('verify failure parks safely', async () => {
  const w = world();
  w.vm.activity = false;
  const code = await runCloud('cutover', w.opts());
  assert.equal(code, 1);
  assert.equal(w.vm.active, false, 'VM stopped');
  assert.equal(w.vm.role?.role, 'vm-dry-run', 'VM held');
  assert.equal(readRole(w.userData)?.role, 'mac-locked', 'Mac stays locked');
  assert.ok(w.lines.some((l) => l.includes(`re-run: robin cloud cutover --host ${HOST}`)));
  // the state machine now allows re-running cutover, and rollback only unlocks
  const allowed = allowedCommands(readRole(w.userData), 'vm-dry-run', HOST);
  assert.ok(allowed.includes('cutover'));
  assert.ok(allowed.includes('rollback'));

  // the VM was resumed before verify failed: its WHOOP token may have rotated
  assert.ok(existsSync(vmRanPath(w.userData)));
  assert.equal(await runCloud('rollback', w.opts()), 1);
  assert.match(w.lines.join('\n'), /robin reauth whoop/);
  assert.match(w.lines.join('\n'), /--accept-token-reset/);
  assert.equal(readRole(w.userData)?.role, 'mac-locked', 'still locked');
  assert.ok(!w.seq.includes('mac:enableMac'));
  const r = await runCloud('rollback', w.opts({ acceptTokenReset: true }));
  assert.equal(r, 0, w.lines.join('\n'));
  assert.equal(readRole(w.userData), null);
  assert.ok(!existsSync(vmRanPath(w.userData)));
  assert.ok(w.lines.filter((l) => l.includes('robin reauth whoop')).length >= 2);
  assert.ok(!w.seq.includes('vm:pullFile'));
  assert.ok(!w.seq.includes('vm:pull'));
  assertSubsequence(w.seq, ['mac:resume', 'mac:enableMac', 'mac:enableAndStartMac']);
});

test('verify failure parks; re-running cutover completes it', async () => {
  const w = world();
  w.vm.doctorExit = 2;
  w.vm.doctorFails = 1;
  assert.equal(await runCloud('cutover', w.opts()), 1);
  assert.equal(w.vm.role?.role, 'vm-dry-run');
  assert.equal(w.vm.active, false);
  w.vm.doctorExit = 1;
  w.vm.doctorFails = 0;
  assert.equal(await runCloud('cutover', w.opts()), 0, w.lines.join('\n'));
  assert.equal(w.vm.role?.role, 'vm-primary');
});

test('incomplete cutover rollback only unlocks', async () => {
  const w = world();
  lock(w);
  setPowerState(w.userData, 'paused');
  w.vm.role = vmRole('vm-dry-run');
  const code = await runCloud('rollback', w.opts());
  assert.equal(code, 0, w.lines.join('\n'));
  assert.equal(readRole(w.userData), null);
  assert.equal(loadPolicies(w.userData).power.state, 'active');
  assert.ok(w.seq.includes('mac:enableAndStartMac'));
  for (const s of ['vm:pull', 'vm:pullFile', 'mac:restore', 'vm:stop', 'vm:db backup']) {
    assert.ok(!w.seq.some((x) => x.startsWith(s)), `unlock-only must not ${s}`);
  }
  assert.ok(
    !readdirSync(join(w.userData, 'state', 'db')).some((f) => f.startsWith('pre-rollback')),
  );
  assert.equal(w.vm.role?.role, 'vm-dry-run', 'VM role untouched');
});

test('gaps gate', async () => {
  const w = world();
  writeFileSync(
    w.settingsPath,
    JSON.stringify({
      hooks: {
        SessionEnd: [
          {
            hooks: [
              {
                type: 'command',
                command: 'curl -s -X POST http://127.0.0.1:41273/hooks/session_end || true',
              },
            ],
          },
        ],
      },
    }),
  );
  w.vm.backupTimer = false;
  const code = await runCloud('cutover', w.opts());
  assert.equal(code, 1);
  const out = w.lines.join('\n');
  assert.match(out, /127\.0\.0\.1:41273/);
  assert.match(out, /backup timer/);
  assert.match(out, /--accept-gaps/);
  assert.equal(readRole(w.userData), null, 'gate refuses before the Mac is locked');
  assert.ok(!w.seq.includes('mac:stopMac'));

  const w2 = world();
  writeFileSync(w2.settingsPath, JSON.stringify({ hooks: {} }));
  w2.vm.backupTimer = false;
  assert.equal(await runCloud('cutover', w2.opts({ acceptGaps: true })), 0, w2.lines.join('\n'));
});

test('remote CLI argv', async () => {
  assert.deepEqual(remoteCliArgv(REPO, ['db', 'backup', '--path=/x']), [
    'env',
    `--chdir=${REPO}`,
    `ROBIN_USER_DATA_DIR=${REPO}/user-data`,
    'node',
    'dist/surfaces/cli/index.js',
    'db',
    'backup',
    '--path=/x',
  ]);
  const w = world();
  assert.equal(await runCloud('cutover', w.opts()), 0, w.lines.join('\n'));
  w.vm.vmDb = join(mkdtempSync(join(tmpdir(), 'robin-vmdb-')), 'snap.sqlite');
  makeDb(w.vm.vmDb, [{ source: 'docs', content: 'written on the vm' }]);
  assert.equal(await runCloud('rollback', w.opts()), 0, w.lines.join('\n'));
  const cli = w.vm.execs.filter((a) => a.includes('dist/surfaces/cli/index.js'));
  assert.ok(cli.length >= 4); // resume, doctor, pause, db backup
  for (const a of cli) {
    assert.deepEqual(a.slice(0, 5), [
      'env',
      `--chdir=${REPO}`,
      `ROBIN_USER_DATA_DIR=${VM_UD}`,
      'node',
      'dist/surfaces/cli/index.js',
    ]);
  }
  const backup = cli.find((a) => a[5] === 'db' && a[6] === 'backup');
  assert.ok(backup);
  assert.match(backup[7], /^--path=\//);
  for (const a of w.vm.execs) assert.ok(!a.includes('--path'), 'never the space-separated form');
});

test('excludes keep the voice corpus home', () => {
  for (const p of [
    'content/sources/imessage/',
    'content/sources/corpus/',
    'content/knowledge/imessage-contacts.md',
    'content/knowledge/biography-from-corpus-*.md',
  ]) {
    assert.ok(MOVE_EXCLUDES.includes(p), p);
  }
});

test('the VM never receives imessage rows', async () => {
  const w = world();
  assert.equal(await runCloud('dry-run', w.opts()), 0, w.lines.join('\n'));
  assertSubsequence(w.seq, ['mac:snapshot', 'mac:scrub', 'vm:pushFile']);
  assert.deepEqual(w.vm.pushedImessage, [0]);
  // the Mac's own DB is never scrubbed
  assert.equal(
    countWhere(w.dbPath, `SELECT count(*) AS n FROM events WHERE source = 'imessage'`),
    2,
  );

  const c = world();
  assert.equal(await runCloud('cutover', c.opts()), 0, c.lines.join('\n'));
  assertSubsequence(c.seq, ['mac:snapshot', 'mac:scrub', 'vm:pushFile']);
  assert.deepEqual(c.vm.pushedImessage, [0]);

  // rollback: the Mac-only rows are restored into the pulled file before it is installed
  c.vm.vmDb = join(mkdtempSync(join(tmpdir(), 'robin-vmdb-')), 'snap.sqlite');
  makeDb(c.vm.vmDb, [{ source: 'docs', content: 'written on the vm' }]);
  assert.equal(await runCloud('rollback', c.opts()), 0, c.lines.join('\n'));
  assertSubsequence(c.seq, ['vm:pullFile', 'mac:restore', 'mac:enableAndStartMac']);
  assert.equal(
    countWhere(c.dbPath, `SELECT count(*) AS n FROM events WHERE source = 'imessage'`),
    2,
  );
});

test('cutover is re-runnable after a failed transfer', async () => {
  const w = world();
  w.vm.pushFails = 1;
  assert.equal(await runCloud('cutover', w.opts()), 1);
  assert.equal(readRole(w.userData)?.role, 'mac-locked');
  assert.ok(!w.seq.includes('vm:start'), 'VM never started');
  assert.equal(w.vm.role?.role, 'vm-dry-run', 'the VM is held while it holds a partial copy');
  assert.ok(
    w.lines.some((l) => l.startsWith('      FAILED: rsync: connection unexpectedly closed')),
  );
  assert.ok(
    w.lines.some((l) => l === `Fix the problem and re-run: robin cloud cutover --host ${HOST}`),
  );
  w.seq.length = 0;
  assert.equal(await runCloud('cutover', w.opts()), 0, w.lines.join('\n'));
  assert.equal(w.vm.role?.role, 'vm-primary');
  assertSubsequence(w.seq, ['mac:stopMac', 'mac:snapshot', 'vm:push', 'vm:pushFile', 'vm:start']);
});

test('dry-run never touches the Mac service and holds the VM before it starts', async () => {
  const w = world();
  assert.equal(await runCloud('dry-run', w.opts()), 0, w.lines.join('\n'));
  for (const s of ['mac:stopMac', 'mac:disableMac', 'mac:enableAndStartMac', 'mac:pause']) {
    assert.ok(!w.seq.includes(s), s);
  }
  assert.equal(readRole(w.userData), null, 'Mac role untouched');
  assert.equal(loadPolicies(w.userData).power.state, 'active');
  const hold = w.seq.indexOf('vm:role vm-dry-run');
  assert.ok(hold >= 0 && hold < w.seq.indexOf('vm:start'));
  assert.ok(hold < w.seq.indexOf('vm:pushFile'), 'held before any data lands');
  assert.ok(!w.seq.includes('vm:role vm-primary'));
  const out = w.lines.join('\n');
  assert.match(out, /snapshot events: 2/);
  assert.match(out, /VM events: 7/);
});

test('rollback pulls the VM data, never a stale snapshot', async () => {
  const w = world();
  lock(w);
  w.vm.role = vmRole('vm-primary');
  w.vm.vmDb = join(mkdtempSync(join(tmpdir(), 'robin-vmdb-')), 'snap.sqlite');
  makeDb(w.vm.vmDb, [
    { source: 'docs', content: 'written on the vm' },
    { source: 'docs', content: 'also on the vm' },
  ]);
  // a side file that appears after the restore read the DB (SQLite discards an invalid hot journal on open)
  w.vm.onTransfer = (op) => {
    if (op === 'pull') writeFileSync(`${w.dbPath}-journal`, 'stale journal');
  };
  const code = await runCloud('rollback', w.opts());
  assert.equal(code, 0, w.lines.join('\n'));
  // the user-data pull keeps every Mac file it overwrites beside user-data
  assert.equal(w.vm.pullBackupDirs.length, 1);
  assert.equal(w.vm.pullBackupDirs[0], `${w.userData}.pre-rollback-2026-11-02T12-00-00-000Z`);
  assertSubsequence(w.seq, [
    'vm:role vm-dry-run',
    'vm:pause',
    'vm:stop',
    'vm:db backup',
    'vm:pullFile',
    'mac:restore',
    'vm:pull',
    'mac:resume',
    'mac:enableMac',
    'mac:enableAndStartMac',
    'mac:health',
    'mac:doctor',
  ]);
  // installed DB = the VM's file plus the restored Mac-only rows
  assert.equal(
    countWhere(w.dbPath, `SELECT count(*) AS n FROM events WHERE payload LIKE '%on the vm%'`),
    2,
  );
  assert.equal(countWhere(w.dbPath, `SELECT count(*) AS n FROM events WHERE source = 'docs'`), 2);
  assert.equal(
    countWhere(w.dbPath, `SELECT count(*) AS n FROM events WHERE source = 'imessage'`),
    2,
  );
  // the previous Mac DB was moved aside, not deleted
  const dbDir = join(w.userData, 'state', 'db');
  const aside = readdirSync(dbDir).filter((f) => f.startsWith('pre-rollback-'));
  assert.equal(aside.length, 1);
  const old = join(dbDir, aside[0], 'robin.sqlite');
  assert.ok(existsSync(old));
  assert.equal(readFileSync(`${old}-journal`, 'utf8'), 'stale journal', '-journal moved aside too');
  assert.ok(!existsSync(`${w.dbPath}-journal`));
  rmSync(`${old}-journal`); // the fixture's journal is junk; a real one would roll back
  assert.equal(
    countWhere(old, `SELECT count(*) AS n FROM events WHERE payload LIKE '%sourdough%'`),
    1,
  );
  assert.equal(readRole(w.userData), null);
  assert.equal(loadPolicies(w.userData).power.state, 'active');
  assert.equal(w.vm.role?.role, 'vm-dry-run', 'the VM stays held');
  assert.equal(w.vm.active, false);
});

test('rollback keeps the Mac locked until the pull succeeds', async () => {
  const w = world();
  lock(w);
  w.vm.role = vmRole('vm-primary');
  w.vm.vmDb = join(mkdtempSync(join(tmpdir(), 'robin-vmdb-')), 'snap.sqlite');
  makeDb(w.vm.vmDb, [{ source: 'docs', content: 'written on the vm' }]);
  w.vm.pullFails = 1;
  assert.equal(await runCloud('rollback', w.opts()), 1);
  assert.equal(readRole(w.userData)?.role, 'mac-locked');
  assert.ok(!w.seq.includes('mac:enableAndStartMac'));
  assert.equal(
    countWhere(w.dbPath, `SELECT count(*) AS n FROM events WHERE payload LIKE '%sourdough%'`),
    1,
  );
  assert.ok(
    !readdirSync(join(w.userData, 'state', 'db')).some((f) => f.startsWith('pre-rollback')),
  );
  // the VM is now held (vm-dry-run), yet this is still a data rollback: a cutover
  // would push the stale Mac DB over the VM's, so only rollback is allowed
  assert.equal(w.vm.role?.role, 'vm-dry-run');
  const before = w.seq.length;
  assert.equal(await runCloud('cutover', w.opts()), 1);
  assert.equal(w.seq.length, before, 'refused without effects');
  assert.match(w.lines.join('\n'), /rollback is in progress/);
  // the re-run (VM already stopped) completes from the saved control group, with the data
  assert.equal(await runCloud('rollback', w.opts()), 0, w.lines.join('\n'));
  assert.equal(w.seq.filter((s) => s === 'vm:pullFile').length, 2);
  assert.equal(
    countWhere(w.dbPath, `SELECT count(*) AS n FROM events WHERE payload LIKE '%on the vm%'`),
    1,
  );
  assert.equal(readRole(w.userData), null);
  assert.ok(!existsSync(join(w.userData, 'state', 'runtime', 'cloud-rollback.json')));
});

test('rollback waits for the VM cgroup children, not the main process', async () => {
  const w = world();
  lock(w);
  w.vm.role = vmRole('vm-primary');
  w.vm.vmDb = join(mkdtempSync(join(tmpdir(), 'robin-vmdb-')), 'snap.sqlite');
  makeDb(w.vm.vmDb, [{ source: 'docs', content: 'written on the vm' }]);
  w.vm.cgroupProcs = [[4242, 777], [4242, 777], [4242], []];
  assert.equal(await runCloud('rollback', w.opts()), 0, w.lines.join('\n'));
  const cats = w.vm.execs.filter((a) => a[0] === 'cat');
  assert.ok(cats.length >= 3);
  for (const a of cats) assert.equal(a[1], `/sys/fs/cgroup${CG}/cgroup.procs`);
  // the main process is not waited on; the stop comes only after the child left
  assertSubsequence(w.seq, [
    'vm:cgroup 4242,777',
    'vm:cgroup 4242,777',
    'vm:cgroup 4242',
    'vm:stop',
    'vm:db backup',
  ]);
});

test('waits for children before the snapshot', async () => {
  const busy: Proc[] = [{ pid: 9001, cmd: 'node dist/agent/runner-entry.js --run 12' }];
  const w = world();
  w.children.push(busy, busy, []);
  assert.equal(await runCloud('cutover', w.opts()), 0, w.lines.join('\n'));
  const polls = w.seq.filter((s) => s === 'mac:children').length;
  assert.ok(polls >= 3);
  const third = w.seq.indexOf(
    'mac:children',
    w.seq.indexOf('mac:children', w.seq.indexOf('mac:children') + 1) + 1,
  );
  assert.ok(w.seq.indexOf('mac:snapshot') > third);
  assert.ok(w.seq.indexOf('mac:stopMac') > third, 'the source stops after it drained');

  const stuck = world();
  stuck.children.push(busy);
  assert.equal(await runCloud('cutover', stuck.opts()), 1);
  const out = stuck.lines.join('\n');
  assert.match(out, /9001/);
  assert.match(out, /runner-entry/);
  assert.ok(!stuck.seq.includes('mac:snapshot'));
  assert.ok(!stuck.seq.includes('vm:push'));
  assert.ok(!stuck.seq.includes('vm:pushFile'));
  assert.equal(readRole(stuck.userData)?.role, 'mac-locked');
});

test('a DB holder after the services stop blocks the snapshot', async () => {
  const w = world();
  const code = await runCloud(
    'cutover',
    w.opts({
      macProcs: {
        children: async () => [],
        dbHolders: async () => [{ pid: 5150, cmd: 'node dist/surfaces/cli/index.js mcp core' }],
      },
    }),
  );
  assert.equal(code, 1);
  assert.match(w.lines.join('\n'), /5150.*mcp core/);
  assert.match(w.lines.join('\n'), /Claude Code/);
  assert.ok(!w.seq.includes('mac:snapshot'));

  const b = world();
  assert.equal(await runCloud('cutover', b.opts({ dbHeldOpenElsewhere: () => true })), 1);
  assert.ok(!b.seq.includes('mac:snapshot'), 'the checkpoint backstop alone blocks too');
});

test('state machine refuses out-of-order commands', async () => {
  const readOnly = (a: string[]) => a[0] === 'true' || (a[0] === 'sh' && !a[2].includes('mv -f'));
  const cases: Array<{
    cmd: 'dry-run' | 'cutover' | 'rollback';
    local: boolean;
    remote: string | null;
  }> = [
    { cmd: 'dry-run', local: true, remote: 'vm-dry-run' },
    { cmd: 'dry-run', local: false, remote: 'vm-primary' },
    { cmd: 'cutover', local: false, remote: 'vm-primary' },
    { cmd: 'cutover', local: true, remote: 'vm-primary' },
    { cmd: 'rollback', local: false, remote: null },
    { cmd: 'rollback', local: false, remote: 'vm-primary' },
  ];
  for (const c of cases) {
    const w = world();
    if (c.local) lock(w);
    if (c.remote) w.vm.role = vmRole(c.remote);
    const code = await runCloud(c.cmd, w.opts());
    assert.equal(code, 1, `${c.cmd} local=${c.local} remote=${c.remote}`);
    assert.deepEqual(w.seq, [], `${c.cmd}: no effects`);
    assert.ok(w.vm.execs.every(readOnly), `${c.cmd}: only reads`);
    const out = w.lines.join('\n');
    assert.match(out, /Allowed now:/);
    assert.match(out, new RegExp(`VM \\(${HOST}\\): ${c.remote ?? 'none'}`));
  }
  // a lock taken for another host is not this host's cutover to resume or roll back
  const other = world();
  writeRole(other.userData, {
    role: 'mac-locked',
    host: 'other-vm',
    at: '2026-11-02T11:00:00.000Z',
  });
  assert.equal(await runCloud('cutover', other.opts()), 1);
  assert.equal(await runCloud('rollback', other.opts()), 1);
  assert.deepEqual(other.seq, []);
});

test('allowedCommands table', () => {
  const locked = { role: 'mac-locked' as const, host: HOST, at: 'x' };
  assert.deepEqual(allowedCommands(null, null, HOST), ['status', 'dry-run', 'cutover']);
  assert.deepEqual(allowedCommands(null, 'vm-dry-run', HOST), ['status', 'dry-run', 'cutover']);
  assert.deepEqual(allowedCommands(null, 'vm-primary', HOST), ['status']);
  assert.deepEqual(allowedCommands(locked, 'vm-dry-run', HOST), ['status', 'cutover', 'rollback']);
  assert.deepEqual(allowedCommands(locked, null, HOST), ['status', 'cutover', 'rollback']);
  assert.deepEqual(allowedCommands(locked, 'vm-primary', HOST), ['status', 'rollback']);
  assert.deepEqual(allowedCommands(locked, 'vm-primary', 'other-vm'), ['status']);
  // a data rollback in progress (VM already held) may only be finished
  assert.deepEqual(allowedCommands(locked, 'vm-dry-run', HOST, true), ['status', 'rollback']);
});

test('both Mac writers stop', async () => {
  assert.deepEqual([...MAC_SERVICE_LABELS], [LAUNCHD_LABEL, 'io.robin-assistant.mcp-remote']);
  const home = mkdtempSync(join(tmpdir(), 'robin-launchd-'));
  mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true });
  for (const l of MAC_SERVICE_LABELS) {
    writeFileSync(join(home, 'Library', 'LaunchAgents', `${l}.plist`), '<plist/>');
  }
  const loaded = new Set<string>(MAC_SERVICE_LABELS);
  const calls: string[][] = [];
  const run: ArgvRunner = async (cmd, args) => {
    assert.equal(cmd, 'launchctl');
    calls.push(args);
    const target = args[1] ?? '';
    const label = target.split('/').pop() ?? '';
    if (args[0] === 'print') return loaded.has(label) ? ok('state = running') : fail(113);
    if (args[0] === 'bootout') {
      if (!loaded.has(label)) return fail(3, 'No such process');
      loaded.delete(label);
      return ok();
    }
    if (args[0] === 'bootstrap') {
      const plist = args[2];
      const l =
        plist
          .split('/')
          .pop()
          ?.replace(/\.plist$/, '') ?? '';
      if (loaded.has(l)) return fail(37, 'already loaded');
      loaded.add(l);
      return ok();
    }
    return ok();
  };
  const svc = macServiceControl({ run, uid: 501, home });
  await svc.stopMac();
  await svc.disableMac();
  for (const l of MAC_SERVICE_LABELS) {
    assert.ok(
      calls.some((a) => a[0] === 'bootout' && a[1] === `gui/501/${l}`),
      `bootout ${l}`,
    );
    assert.ok(
      calls.some((a) => a[0] === 'disable' && a[1] === `gui/501/${l}`),
      `disable ${l}`,
    );
  }
  assert.equal(loaded.size, 0);
  // idempotent: a second stop/disable on stopped services is fine
  calls.length = 0;
  await svc.stopMac();
  await svc.disableMac();
  assert.ok(!calls.some((a) => a[0] === 'bootout'), 'nothing loaded → no bootout');

  calls.length = 0;
  await svc.enableMac();
  assert.deepEqual(
    calls.map((a) => a.join(' ')),
    MAC_SERVICE_LABELS.map((l) => `enable gui/501/${l}`),
    'enableMac only enables, never loads',
  );
  assert.equal(loaded.size, 0);
  await svc.enableAndStartMac();
  for (const l of MAC_SERVICE_LABELS) {
    assert.ok(
      calls.some((a) => a[0] === 'enable' && a[1] === `gui/501/${l}`),
      `enable ${l}`,
    );
    assert.ok(
      calls.some(
        (a) =>
          a[0] === 'bootstrap' &&
          a[1] === 'gui/501' &&
          a[2] === join(home, 'Library', 'LaunchAgents', `${l}.plist`),
      ),
      `bootstrap ${l}`,
    );
  }
  assert.equal(loaded.size, 2);
  await svc.enableAndStartMac(); // already loaded → no error

  // a label whose plist is absent is skipped (but anything loaded still stops)
  const bare = mkdtempSync(join(tmpdir(), 'robin-launchd-'));
  calls.length = 0;
  const svc2 = macServiceControl({ run, uid: 501, home: bare });
  await svc2.disableMac();
  await svc2.enableMac();
  await svc2.enableAndStartMac();
  assert.deepEqual(calls, []);
  await svc2.stopMac();
  assert.equal(loaded.size, 0);

  // runCloud: cutover stops + disables, rollback re-enables
  const w = world();
  assert.equal(await runCloud('cutover', w.opts()), 0, w.lines.join('\n'));
  assertSubsequence(w.seq, ['mac:stopMac', 'mac:disableMac']);
  w.vm.vmDb = join(mkdtempSync(join(tmpdir(), 'robin-vmdb-')), 'snap.sqlite');
  makeDb(w.vm.vmDb, [{ source: 'docs', content: 'written on the vm' }]);
  assert.equal(await runCloud('rollback', w.opts()), 0, w.lines.join('\n'));
  assert.ok(w.seq.includes('mac:enableAndStartMac'));
});

test('refuses without confirmation', async () => {
  for (const cmd of ['cutover', 'rollback'] as const) {
    const w = world();
    if (cmd === 'rollback') lock(w);
    const code = await runCloud(cmd, w.opts({ yes: false, prompt: null }));
    assert.equal(code, 1);
    assert.deepEqual(w.vm.execs, [], `${cmd}: no remote calls`);
    assert.deepEqual(w.localRuns, [], `${cmd}: no local calls`);
    assert.deepEqual(w.seq, []);
    assert.match(w.lines.join('\n'), /--yes/);
  }
  // a mistyped answer refuses; the exact command name proceeds
  const w = world();
  assert.equal(await runCloud('cutover', w.opts({ yes: false, prompt: async () => 'yes' })), 1);
  assert.deepEqual(w.seq, []);
  assert.equal(
    await runCloud('cutover', w.opts({ yes: false, prompt: async () => 'cutover\n' })),
    0,
    w.lines.join('\n'),
  );
});

test('preflight blocks on commit mismatch', async () => {
  for (const cmd of ['dry-run', 'cutover'] as const) {
    const w = world();
    w.vm.head = 'ffffffffffffffffffffffffffffffffffffffff';
    assert.equal(await runCloud(cmd, w.opts()), 1);
    assert.match(w.lines.join('\n'), /commit/);
    assert.deepEqual(w.seq, [], `${cmd}: nothing ran`);
    assert.equal(readRole(w.userData), null);
  }
});

test('preflight refuses openrsync, a missing build and a full disk', async () => {
  const w = world();
  const run: ArgvRunner = async (cmd, args) => {
    if (cmd === 'git') return ok(`${HEAD}\n`);
    if (args[0] === '--version') {
      return ok('openrsync: protocol version 29\nrsync version 2.6.9 compatible\n');
    }
    return fail(127);
  };
  assert.equal(await runCloud('dry-run', w.opts({ run })), 1);
  assert.match(w.lines.join('\n'), /GNU rsync/);

  const b = world();
  b.vm.stamp = false;
  assert.equal(await runCloud('dry-run', b.opts()), 1);
  assert.match(b.lines.join('\n'), /build-stamp/);

  const d = world();
  d.vm.freeKb = 1;
  assert.equal(await runCloud('dry-run', d.opts()), 1);
  assert.match(d.lines.join('\n'), /disk/);
  assert.deepEqual([...b.seq, ...d.seq], []);
});

test('status prints both roles, both daemons and the writer; changes nothing', async () => {
  const w = world();
  lock(w);
  w.vm.role = vmRole('vm-primary');
  assert.equal(await runCloud('status', w.opts({ yes: false })), 0);
  const out = w.lines.join('\n');
  assert.match(out, /Mac: mac-locked/);
  assert.match(out, new RegExp(`VM \\(${HOST}\\): vm-primary`));
  assert.match(out, /writer: the VM/i);
  assert.ok(
    w.seq.every((s) => s.endsWith(':health')),
    w.seq.join(','),
  );

  const n = world();
  assert.equal(await runCloud('status', n.opts()), 0);
  assert.match(n.lines.join('\n'), /writer: this Mac/i);
});

test('waitQuiescent polls until the list empties or times out', async () => {
  const lists: Proc[][] = [[{ pid: 1, cmd: 'a' }], [{ pid: 1, cmd: 'a' }], []];
  let polls = 0;
  const slept: number[] = [];
  const r = await waitQuiescent(
    async () => {
      polls++;
      return lists.shift() ?? [];
    },
    { timeoutMs: 60_000, pollMs: 5_000, sleep: async (ms) => void slept.push(ms) },
  );
  assert.deepEqual(r, { ok: true });
  assert.equal(polls, 3);
  assert.deepEqual(slept, [5_000, 5_000]);

  const stuck = await waitQuiescent(async () => [{ pid: 7, cmd: 'x' }], {
    timeoutMs: 10_000,
    pollMs: 5_000,
    sleep: async () => {},
  });
  assert.deepEqual(stuck, { ok: false, remaining: [{ pid: 7, cmd: 'x' }] });
});

test('cgroupProcsArgv never reads an empty or foreign control group', () => {
  assert.deepEqual(cgroupProcsArgv(), [
    ['systemctl', '--user', 'show', '-p', 'ControlGroup', '--value', 'robin-daemon'],
  ]);
  assert.deepEqual(cgroupProcsArgv(CG)[1], ['cat', `/sys/fs/cgroup${CG}/cgroup.procs`]);
  for (const bad of [
    '',
    '  ',
    '/',
    '/user.slice/other.service',
    'robin-daemon.service',
    '/a/../robin-daemon.service',
  ]) {
    assert.throws(() => cgroupProcsArgv(bad), /control group/, JSON.stringify(bad));
  }
});

test('parsers: ps, lsof, rsync --version', () => {
  assert.deepEqual(parsePs('  12 /usr/bin/node dist/agent/runner-entry.js\n 3 -zsh\n'), [
    { pid: 12, cmd: '/usr/bin/node dist/agent/runner-entry.js' },
    { pid: 3, cmd: '-zsh' },
  ]);
  assert.deepEqual(parseLsof('p101\ncnode\nf12\np202\ncClaude\n', 202), [
    { pid: 101, cmd: 'node' },
  ]);
  assert.deepEqual(parseRsyncVersion('rsync  version 3.4.1  protocol version 32\n'), {
    gnu: true,
    major: 3,
  });
  assert.equal(
    parseRsyncVersion('openrsync: protocol version 29\nrsync version 2.6.9 compatible').gnu,
    false,
  );
  assert.equal(parseRsyncVersion('rsync  version 2.6.9  protocol version 29').major, 2);
});

// --- fix round 1 ------------------------------------------------------------

const vmDbFor = (w: World, events = [{ source: 'docs', content: 'written on the vm' }]) => {
  w.vm.vmDb = join(mkdtempSync(join(tmpdir(), 'robin-vmdb-')), 'snap.sqlite');
  makeDb(w.vm.vmDb, events);
};

test('a concurrent robin cloud run is refused while one holds the op lock', async () => {
  const w = world();
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let draining!: () => void;
  const inDrain = new Promise<void>((r) => {
    draining = r;
  });
  // cutover blocks in its drain until released
  w.children.push([], [{ pid: 9001, cmd: 'node dist/agent/runner-entry.js' }], [], []);
  const first = runCloud(
    'cutover',
    w.opts({
      sleep: async () => {
        draining();
        await gate;
      },
    }),
  );
  await inDrain;
  const held = JSON.parse(readFileSync(opLockPath(w.userData), 'utf8')) as Record<string, unknown>;
  assert.equal(held.pid, process.pid);
  assert.equal(held.command, 'cutover');
  assert.equal(typeof held.startedAt, 'string');
  const lines: string[] = [];
  const second = await runCloud('rollback', w.opts({ log: (l) => lines.push(l) }));
  assert.equal(second, 1);
  assert.match(
    lines.join('\n'),
    new RegExp(`another robin cloud cutover is running \\(pid ${process.pid}\\)`),
  );
  assert.equal(readRole(w.userData)?.role, 'mac-locked', 'the second run changed nothing');
  // status is read-only and does not take the lock
  assert.equal(await runCloud('status', w.opts({ log: () => {} })), 0);
  release();
  assert.equal(await first, 0, w.lines.join('\n'));
  assert.ok(!existsSync(opLockPath(w.userData)), 'released in finally');
  assert.equal(w.vm.role?.role, 'vm-primary');
});

test('a stale op lock refuses with its details and is never removed', async () => {
  const w = world();
  mkdirSync(join(w.userData, 'state', 'runtime'), { recursive: true });
  const body = JSON.stringify({
    pid: 999_999,
    command: 'cutover',
    startedAt: '2026-11-01T09:00:00.000Z',
  });
  writeFileSync(opLockPath(w.userData), body);
  assert.equal(await runCloud('dry-run', w.opts({ pidAlive: () => false })), 1);
  const out = w.lines.join('\n');
  assert.match(out, /stale lock from pid 999999 \(cutover, 2026-11-01T09:00:00.000Z\)/);
  assert.match(out, /check robin cloud status, then delete .*cloud-op\.lock/);
  assert.equal(readFileSync(opLockPath(w.userData), 'utf8'), body, 'never auto-removed');
  assert.deepEqual(w.vm.execs, []);
  assert.equal(await runCloud('dry-run', w.opts({ pidAlive: () => true })), 1);
  assert.match(w.lines.join('\n'), /another robin cloud cutover is running \(pid 999999\)/);
  assert.equal(readFileSync(opLockPath(w.userData), 'utf8'), body);
});

test('cutover re-checks its lock before marking the VM primary', async () => {
  const w = world();
  w.vm.onTransfer = (op) => {
    if (op === 'pushFile') {
      writeRole(w.userData, { role: 'mac-locked', host: HOST, at: 'someone-else' });
    }
  };
  assert.equal(await runCloud('cutover', w.opts()), 1);
  assert.match(w.lines.join('\n'), /lock changed during the run/);
  assert.ok(!w.seq.includes('vm:role vm-primary'));
  assert.ok(!w.seq.includes('vm:start'));
  assert.equal(w.vm.role?.role, 'vm-dry-run');
});

test('rollback re-checks its lock before installing the VM DB', async () => {
  const w = world();
  lock(w);
  w.vm.role = vmRole('vm-primary');
  vmDbFor(w);
  w.vm.onTransfer = (op) => {
    if (op === 'pull') writeRole(w.userData, { role: 'mac-locked', host: HOST, at: 'changed' });
  };
  assert.equal(await runCloud('rollback', w.opts()), 1);
  assert.match(w.lines.join('\n'), /lock changed during the run/);
  assert.ok(
    !readdirSync(join(w.userData, 'state', 'db')).some((f) => f.startsWith('pre-rollback')),
  );
  assert.equal(
    countWhere(w.dbPath, `SELECT count(*) AS n FROM events WHERE payload LIKE '%sourdough%'`),
    1,
  );
});

test('the rollback record is written atomically and an unreadable one refuses', async () => {
  const w = world();
  lock(w);
  w.vm.role = vmRole('vm-primary');
  vmDbFor(w);
  w.vm.pullFails = 1;
  assert.equal(await runCloud('rollback', w.opts()), 1);
  const runtime = join(w.userData, 'state', 'runtime');
  assert.ok(!readdirSync(runtime).some((f) => f.endsWith('.tmp')), 'no temp left behind');
  const rec = JSON.parse(readFileSync(rollbackRecordPath(w.userData), 'utf8')) as Record<
    string,
    unknown
  >;
  assert.equal(rec.host, HOST);
  assert.equal(rec.lockAt, '2026-11-02T11:00:00.000Z');
  assert.match(String(rec.controlGroup), /robin-daemon\.service$/);

  writeFileSync(rollbackRecordPath(w.userData), '{"host": "exa');
  for (const cmd of ['rollback', 'cutover'] as const) {
    const before = w.seq.length;
    assert.equal(await runCloud(cmd, w.opts()), 1, cmd);
    assert.equal(w.seq.length, before, `${cmd}: no effects`);
  }
  assert.match(w.lines.join('\n'), /rollback record .* is unreadable; fix or remove it by hand/);
  w.lines.length = 0;
  assert.equal(await runCloud('status', w.opts()), 0);
  assert.match(w.lines.join('\n'), /unreadable/);
});

test('a failed service start after the unlock prints both labels to finish by hand', async () => {
  const w = world();
  lock(w);
  w.vm.role = vmRole('vm-dry-run');
  w.mac.startFails = 1;
  assert.equal(await runCloud('rollback', w.opts()), 1);
  const out = w.lines.join('\n');
  assert.match(out, /already unlocked; robin cloud rollback no longer applies/);
  for (const l of MAC_SERVICE_LABELS) {
    assert.ok(
      out.includes(`launchctl enable gui/$(id -u)/${l} && launchctl bootstrap gui/$(id -u)`),
      l,
    );
  }
  assert.ok(!out.includes('Fix the problem and re-run: robin cloud rollback'));
  const text = finishByHand({ o: { host: HOST } });
  for (const l of MAC_SERVICE_LABELS) assert.ok(text.includes(`${l}.plist`), l);
  const lines = startByHandLines('/h');
  assert.equal(lines.length, 2);
  assert.ok(lines[1].includes('/h/Library/LaunchAgents/io.robin-assistant.mcp-remote.plist'));
});

test('status says when this Mac is unlocked but its daemon is down', async () => {
  const w = world();
  w.mac.healthy = false;
  assert.equal(await runCloud('status', w.opts()), 0);
  const out = w.lines.join('\n');
  assert.match(out, /unlocked but its daemon is down/);
  for (const l of MAC_SERVICE_LABELS) assert.ok(out.includes(`gui/$(id -u)/${l}`), l);
  const up = world();
  assert.equal(await runCloud('status', up.opts()), 0);
  assert.ok(!up.lines.join('\n').includes('daemon is down'));
});

test('unparseable doctor output fails verification', async () => {
  const w = world();
  w.vm.doctorRaw = 'Error: Cannot find module';
  assert.equal(await runCloud('dry-run', w.opts()), 1);
  assert.match(w.lines.join('\n'), /VM doctor printed no JSON report/);
  const m = world();
  lock(m);
  m.vm.role = vmRole('vm-dry-run');
  m.mac.doctorRaw = 'segfault';
  assert.equal(await runCloud('rollback', m.opts()), 1);
  assert.match(m.lines.join('\n'), /Mac doctor printed no JSON report/);
});

test('rollback preflight checks the Mac has room for the VM data', async () => {
  const w = world();
  lock(w);
  w.vm.role = vmRole('vm-primary');
  vmDbFor(w);
  w.vm.duKb = 10_000_000;
  w.vm.backupsKb = 1_000_000;
  w.mac.freeKb = 17_000_000; // needs 2 × 9 GB
  assert.equal(await runCloud('rollback', w.opts()), 1);
  assert.match(w.lines.join('\n'), /this Mac has .* free disk; bringing the VM's data home needs/);
  assert.deepEqual(w.seq, []);
  w.mac.freeKb = 19_000_000;
  assert.equal(await runCloud('rollback', w.opts()), 0, w.lines.join('\n'));
});

test('cutover refuses while an auto-land probation runs', async () => {
  const w = world();
  w.children.push([{ pid: 4321, cmd: 'node dist/agent/land-probation.js' }]);
  assert.equal(await runCloud('cutover', w.opts()), 1);
  assert.match(w.lines.join('\n'), /auto-land probation is running \(pid 4321\).*wait for it/);
  assert.equal(readRole(w.userData), null, 'refused before the lock');
  assert.ok(!w.seq.includes('mac:pause'));
});

test('a start or resume failure parks the VM too', async () => {
  for (const which of ['start', 'resume'] as const) {
    const w = world();
    if (which === 'start') w.vm.startFails = 1;
    else w.vm.resumeFails = 1;
    assert.equal(await runCloud('cutover', w.opts()), 1, which);
    assert.equal(w.vm.role?.role, 'vm-dry-run', `${which}: held`);
    assert.equal(w.vm.active, false, `${which}: stopped`);
    assert.equal(readRole(w.userData)?.role, 'mac-locked');
    assert.equal(existsSync(vmRanPath(w.userData)), which === 'resume', `${which}: vm-ran note`);
    assert.equal(await runCloud('cutover', w.opts()), 0, w.lines.join('\n'));
  }
});

test('carry-oauth runs on cutover only', async () => {
  const d = world();
  assert.equal(await runCloud('dry-run', d.opts()), 0);
  assert.ok(!d.seq.includes('vm:carry-oauth'));
  const c = world();
  assert.equal(await runCloud('cutover', c.opts()), 0);
  assertSubsequence(c.seq, ['vm:pushFile', 'vm:carry-oauth', 'vm:install-db']);
});

// VM_DB_SCRIPT runs for real against temp DBs (the repo's better-sqlite3, as on the VM).
function vmScript(mode: string, ...args: string[]): string {
  return execFileSync(process.execPath, ['-e', VM_DB_SCRIPT, mode, ...args], {
    cwd: join(import.meta.dirname, '..', '..', '..'),
    encoding: 'utf8',
  }).trim();
}

test('VM_DB_SCRIPT: count and held', () => {
  const dir = mkdtempSync(join(tmpdir(), 'robin-vmscript-'));
  const db = join(dir, 'robin.sqlite');
  makeDb(db, [
    { source: 'docs', content: 'one' },
    { source: 'docs', content: 'two' },
    { source: 'docs', content: 'three' },
  ]);
  assert.equal(vmScript('count', db), '3');
  assert.equal(vmScript('held', db), 'free');
  assert.equal(vmScript('held', join(dir, 'missing.sqlite')), 'free');
  const holder = openDb(db);
  try {
    holder.prepare('SELECT count(*) FROM events').get();
    assert.equal(vmScript('held', db), 'held');
  } finally {
    closeDb(holder);
  }
  assert.equal(vmScript('held', db), 'free');
});

test('VM_DB_SCRIPT: activity counts finished jobs and integration attempts after the start', () => {
  const dir = mkdtempSync(join(tmpdir(), 'robin-vmscript-'));
  const db = join(dir, 'robin.sqlite');
  makeDb(db, []);
  const since = '2026-11-02T12:00:00Z';
  const h = openDb(db);
  try {
    const job = h.prepare(
      `INSERT INTO jobs (name, trigger_kind, scheduled_at, state, created_at) VALUES (?, 'cron', '2026-11-02T12:00:00Z', ?, ?)`,
    );
    job.run('before', 'completed', '2026-11-02 11:59:59');
    job.run('pending-after', 'pending', '2026-11-02 12:00:05'); // boot-time registration: not work
    assert.deepEqual(JSON.parse(vmScript('activity', db, since)), { jobs: 0, integrations: 0 });
    job.run('ran-after', 'completed', '2026-11-02 12:03:00');
    const kv = h.prepare(
      'INSERT INTO integration_state (integration_name, key, value, updated_at) VALUES (?, ?, ?, ?)',
    );
    kv.run('bike', 'last_attempt_at', '2026-11-02T12:04:00.000Z', '2026-11-02T12:04:00.000Z');
    kv.run('oven', 'last_attempt_at', '2026-11-02T11:00:00.000Z', '2026-11-02T11:00:00.000Z');
  } finally {
    closeDb(h);
  }
  assert.deepEqual(JSON.parse(vmScript('activity', db, since)), { jobs: 1, integrations: 1 });
});

test('VM_DB_SCRIPT: carry-oauth keeps only newer rows the incoming DB still has', () => {
  const dir = mkdtempSync(join(tmpdir(), 'robin-vmscript-'));
  const vm = join(dir, 'vm.sqlite');
  const inc = join(dir, 'incoming.sqlite');
  makeDb(vm, []);
  makeDb(inc, []);
  const put = (path: string, rows: Array<[string, string, string, string]>) => {
    const h = openDb(path);
    try {
      const st = h.prepare(
        'INSERT INTO integration_state (integration_name, key, value, updated_at) VALUES (?, ?, ?, ?)',
      );
      for (const r of rows) st.run(...r);
    } finally {
      closeDb(h);
    }
  };
  put(vm, [
    ['bike', 'refresh_token', 'vm-new', '2026-11-02T12:10:00.000Z'], // newer → carried
    ['oven', 'access_token', 'vm-old', '2026-11-02 08:00:00'], // older (space format) → incoming kept
    ['loom', 'refresh_token', 'vm-only', '2026-11-02T12:10:00.000Z'], // Mac deleted it → not resurrected
    ['bike', 'cursor', 'vm-cursor', '2026-11-02T12:10:00.000Z'], // not an OAuth key
  ]);
  put(inc, [
    ['bike', 'refresh_token', 'mac-old', '2026-11-02 11:00:00'],
    ['oven', 'access_token', 'mac-new', '2026-11-02T09:00:00.000Z'],
    ['bike', 'cursor', 'mac-cursor', '2026-11-02T09:00:00.000Z'],
  ]);
  assert.equal(vmScript('carry-oauth', vm, inc), '1');
  const ro = new Database(inc, { readonly: true });
  const rows = ro
    .prepare(
      `SELECT integration_name || ':' || key || '=' || value AS r FROM integration_state ORDER BY 1`,
    )
    .all() as Array<{ r: string }>;
  ro.close();
  assert.deepEqual(
    rows.map((x) => x.r),
    ['bike:cursor=mac-cursor', 'bike:refresh_token=vm-new', 'oven:access_token=mac-new'],
  );
  assert.equal(vmScript('carry-oauth', join(dir, 'none.sqlite'), inc), '0');
});

test('the Mac-side cloud records never cross machines', () => {
  for (const p of ['state/runtime/cloud-rollback.json', 'state/runtime/cloud-vm-ran.json']) {
    assert.ok(MOVE_EXCLUDES.includes(p), p);
  }
  assert.ok(MOVE_EXCLUDES.includes('state/runtime/*.lock'), 'covers cloud-op.lock');
  assert.ok(opLockPath('/u').endsWith('state/runtime/cloud-op.lock'));
});
