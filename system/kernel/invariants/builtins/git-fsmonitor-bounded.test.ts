import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gitFsmonitorBoundedInvariant } from './git-fsmonitor-bounded.ts';

const DAEMON = '/usr/libexec/git-core/git fsmonitor--daemon run --detach --ipc-threads=8';

test('git.fsmonitor_bounded: ok at or below the threshold, warns above it', async () => {
  const pids = [101, 102, 103];
  const inv = gitFsmonitorBoundedInvariant({ listPids: () => pids, warnAbove: 3 });
  assert.equal((await inv.check()).ok, true);
  pids.push(104);
  const r = await inv.check();
  assert.equal(r.ok, false);
  assert.match(r.message ?? '', /4 git fsmonitor daemons/);
});

test('git.fsmonitor_bounded: repair SIGTERMs only processes that are still fsmonitor daemons', async () => {
  const killed: number[] = [];
  const argv: Record<number, string> = { 1: DAEMON, 2: '/bin/zsh', 3: DAEMON };
  const inv = gitFsmonitorBoundedInvariant({
    listPids: () => [1, 2, 3],
    argvOf: (pid) => argv[pid] ?? '',
    kill: (pid, sig) => {
      assert.equal(sig, 'SIGTERM');
      killed.push(pid);
    },
    warnAbove: 0,
  });
  await inv.repair?.();
  assert.deepEqual(killed, [1, 3], 'a recycled pid running something else is left alone');
});

test('git.fsmonitor_bounded: a process that exits mid-repair does not throw', async () => {
  const inv = gitFsmonitorBoundedInvariant({
    listPids: () => [7],
    argvOf: () => DAEMON,
    kill: () => {
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    },
  });
  await assert.doesNotReject(async () => inv.repair?.());
});
