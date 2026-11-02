import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseEtime, runProbation, SETTLED_SEC } from './land-probation.ts';

test('parseEtime: macOS ps etime shapes', () => {
  assert.equal(parseEtime('  00:42\n'), 42);
  assert.equal(parseEtime('19:16'), 19 * 60 + 16);
  assert.equal(parseEtime('02:03:04'), 2 * 3600 + 3 * 60 + 4);
  assert.equal(parseEtime('1-00:00:05'), 86_400 + 5);
  assert.ok(Number.isNaN(parseEtime('')));
});

function deps(uptimes: Array<number | null>) {
  let reverted = 0;
  let slept = 0;
  return {
    reverted: () => reverted,
    slept: () => slept,
    d: {
      daemonUptimeSec: () => uptimes.shift() ?? null,
      sleep: async () => {
        slept++;
      },
      revert: () => {
        reverted++;
      },
    },
  };
}

test('runProbation: a settled daemon passes on the first look', async () => {
  const t = deps([SETTLED_SEC + 80]);
  assert.equal(await runProbation(t.d), 'healthy');
  assert.equal(t.reverted(), 0);
  assert.equal(t.slept(), 0);
});

test('runProbation: an unrelated restart on the first look is absorbed by the re-check', async () => {
  const t = deps([5, SETTLED_SEC + 1]);
  assert.equal(await runProbation(t.d), 'healthy');
  assert.equal(t.reverted(), 0);
});

test('runProbation: a daemon that is down or crash-looping on both looks is reverted', async () => {
  const down = deps([null, null]);
  assert.equal(await runProbation(down.d), 'reverted');
  assert.equal(down.reverted(), 1);
  const looping = deps([3, 7]);
  assert.equal(await runProbation(looping.d), 'reverted');
});

test('makeRevert: systemd records revert, build, then one restart last', async () => {
  const { makeRevert } = await import('./land-probation.ts');
  const calls: string[][] = [];
  makeRevert({
    run: (c, a) => void calls.push([c, ...a]),
    commit: 'abc',
    mgr: 'systemd',
    onDetail: () => {},
  })();
  assert.deepEqual(calls, [
    ['git', 'revert', '-m', '1', '--no-edit', 'abc'],
    ['pnpm', 'build'],
    ['systemctl', '--user', 'restart', 'robin-daemon.service'],
  ]);
});

test('makeRevert: launchd restarts with kickstart last; none records no restart', async () => {
  const { makeRevert } = await import('./land-probation.ts');
  const calls: string[][] = [];
  makeRevert({
    run: (c, a) => void calls.push([c, ...a]),
    commit: 'abc',
    mgr: 'launchd',
    onDetail: () => {},
  })();
  const last = calls[calls.length - 1];
  assert.equal(last[0], 'launchctl');
  assert.deepEqual(last.slice(1, 3), ['kickstart', '-k']);
  assert.match(last[3], /^gui\/\d+\/io\.robin-assistant\.daemon$/);
  const none: string[][] = [];
  makeRevert({
    run: (c, a) => void none.push([c, ...a]),
    commit: 'abc',
    mgr: 'none',
    onDetail: () => {},
  })();
  assert.equal(none.length, 2);
});

test('makeRevert: a build failure sets the FAILED detail and still restarts', async () => {
  const { makeRevert } = await import('./land-probation.ts');
  const calls: string[][] = [];
  let detail = '';
  makeRevert({
    run: (c, a) => {
      calls.push([c, ...a]);
      if (c === 'pnpm') throw new Error('boom\nmore');
    },
    commit: 'abc',
    mgr: 'systemd',
    onDetail: (d) => {
      detail = d;
    },
  })();
  assert.match(detail, /^revert\/rebuild FAILED — main needs attention: boom$/);
  assert.equal(calls[calls.length - 1][0], 'systemctl');
});

test('restartCommand: launchd keeps the kickstart argv, systemd uses systemctl --user', async () => {
  const { restartCommand } = await import('./land-probation.ts');
  assert.deepEqual(restartCommand('launchd', 501), [
    'launchctl',
    'kickstart',
    '-k',
    'gui/501/io.robin-assistant.daemon',
  ]);
  assert.deepEqual(restartCommand('systemd'), [
    'systemctl',
    '--user',
    'restart',
    'robin-daemon.service',
  ]);
  assert.equal(restartCommand('none'), null);
});
