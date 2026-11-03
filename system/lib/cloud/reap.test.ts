import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseProcStartMs, reap, reapCandidates } from './reap.ts';

const H = 3_600_000;
const now = 100 * H;
const procs = [
  { pid: 10, startedAtMs: now - 50 * H, cmd: 'node cli.js daemon --foreground' },
  { pid: 11, startedAtMs: now - 7 * H, cmd: 'node agent-run.js' },
  { pid: 12, startedAtMs: now - 1 * H, cmd: 'node cognition.js' },
  { pid: 13, startedAtMs: now - 6 * H, cmd: 'exactly six hours' },
];

describe('reapCandidates', () => {
  it('never the main pid, never young, includes old', () => {
    assert.deepEqual(reapCandidates({ procs, mainPid: 10, nowMs: now, maxAgeMs: 6 * H }), [11]);
  });
  it('defaults to six hours (boundary is strictly older)', () => {
    assert.deepEqual(reapCandidates({ procs, mainPid: 10, nowMs: now }), [11]);
  });
});

describe('parseProcStartMs', () => {
  it('handles parens and spaces in comm', () => {
    const rest = Array.from({ length: 50 }, (_, i) => String(i));
    rest[18] = '2000';
    const stat = `42 (we ) ird) S ${rest.slice(0, 50).join(' ')}`;
    // fields after ')' start at field 3 ("S"); starttime is field 22 = index 19 after state
    const ms = parseProcStartMs(stat, 1000, 100);
    assert.equal(ms, 1000 * 1000 + 20_000);
  });
});

function deps(over: Record<string, unknown> = {}) {
  const calls: string[][] = [];
  const killed: Array<[number, string]> = [];
  const logs: string[] = [];
  const alive = new Set([11]);
  return {
    calls,
    killed,
    logs,
    d: {
      exec: async (cmd: string, args: string[]) => {
        calls.push([cmd, ...args]);
        if (args.includes('ControlGroup')) {
          return {
            stdout: (over.cg as string) ?? '/user.slice/user-1000.slice/robin-daemon.service\n',
          };
        }
        if (args.includes('MainPID')) return { stdout: '10\n' };
        return { stdout: '10\n11\n12\n' };
      },
      readProc: async (pid: number) => {
        const p = procs.find((x) => x.pid === pid);
        return p ? { startedAtMs: p.startedAtMs, cmd: p.cmd } : null;
      },
      kill: (pid: number, sig: string) => {
        killed.push([pid, sig]);
        if (sig === 'SIGKILL') alive.delete(pid);
      },
      isAlive: (pid: number) => alive.has(pid),
      sleep: async () => {},
      now: () => now,
      log: (l: string) => logs.push(l),
    },
  };
}

describe('reap', () => {
  it('empty ControlGroup means nothing to reap, never reads cgroup.procs', async () => {
    const x = deps({ cg: '\n' });
    const r = await reap({ ...x.d });
    assert.equal(r.status, 'not-running');
    assert.ok(x.logs.some((l) => l.includes('daemon not running — nothing to reap')));
    assert.ok(!x.calls.some((c) => c[0] === 'cat'));
  });
  it('foreign / root cgroup is treated as not running', async () => {
    const x = deps({ cg: '/\n' });
    assert.equal((await reap({ ...x.d })).status, 'not-running');
    assert.ok(!x.calls.some((c) => c[0] === 'cat'));
  });
  it('dry-run lists but kills nothing', async () => {
    const x = deps();
    const r = await reap({ ...x.d, dryRun: true });
    assert.deepEqual(r.pids, [11]);
    assert.equal(x.killed.length, 0);
    assert.ok(x.logs.some((l) => l.startsWith('would reap 11 node age=7')));
  });
  it('pid reused after SIGTERM: no SIGKILL', async () => {
    const x = deps();
    let reads = 0;
    const base = x.d.readProc;
    x.d.readProc = async (pid: number) => {
      const r = await base(pid);
      // listing + pre-TERM check are reads 1-2 for pid 11; later reads see a new process
      if (pid === 11 && ++reads > 2 && r) return { ...r, startedAtMs: now - 1000 };
      return r;
    };
    await reap({ ...x.d });
    assert.deepEqual(x.killed, [[11, 'SIGTERM']]);
    assert.ok(x.logs.includes('skipped 11: changed'));
  });
  it('pid that left the cgroup is not signalled', async () => {
    const x = deps();
    let cats = 0;
    const base = x.d.exec;
    x.d.exec = async (cmd: string, args: string[]) => {
      if (cmd === 'cat' && ++cats > 1) return { stdout: '10\n12\n' };
      return base(cmd, args);
    };
    await reap({ ...x.d });
    assert.equal(x.killed.length, 0);
    assert.ok(x.logs.includes('skipped 11: changed'));
  });
  it('SIGTERMs then SIGKILLs a survivor', async () => {
    const x = deps();
    const r = await reap({ ...x.d });
    assert.deepEqual(r.pids, [11]);
    assert.deepEqual(x.killed, [
      [11, 'SIGTERM'],
      [11, 'SIGKILL'],
    ]);
    assert.ok(x.logs.some((l) => l.startsWith('reaped 11 node age=7')));
  });
});
