import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pidFilePath } from '../paths.ts';
import {
  detectServiceManager,
  isSupervised,
  restartArgv,
  restartDaemon,
  restartShellCommand,
} from './manager.ts';

test('darwin restart argv unchanged', () => {
  assert.deepEqual(restartArgv('launchd', 501), [
    'launchctl',
    'kickstart',
    '-k',
    'gui/501/io.robin-assistant.daemon',
  ]);
});

test('systemd restart argv', () => {
  assert.deepEqual(restartArgv('systemd'), [
    'systemctl',
    '--user',
    'restart',
    'robin-daemon.service',
  ]);
  assert.equal(restartArgv('none'), null);
});

test('detect', () => {
  assert.equal(detectServiceManager({ platform: 'darwin' }), 'launchd');
  assert.equal(detectServiceManager({ platform: 'linux', hasSystemctl: () => true }), 'systemd');
  assert.equal(detectServiceManager({ platform: 'linux', hasSystemctl: () => false }), 'none');
  assert.equal(detectServiceManager({ platform: 'win32' }), 'none');
});

test('restartShellCommand quotes', () => {
  assert.equal(
    restartShellCommand('systemd', { pidfile: '/x/robin.pid' }),
    'systemctl --user restart robin-daemon.service',
  );
  const cmd = restartShellCommand('none', { pidfile: '/tmp/a b/robin.pid' });
  assert.ok(cmd.includes("'/tmp/a b/robin.pid'"));
  assert.ok(cmd.startsWith('kill -TERM'));
});

test('isSupervised systemd', async () => {
  assert.equal(await isSupervised('systemd', async () => ({ stdout: 'active\n' })), true);
  assert.equal(await isSupervised('systemd', async () => ({ stdout: 'inactive\n' })), false);
  assert.equal(
    await isSupervised('systemd', async () => {
      throw new Error('boom');
    }),
    false,
  );
  assert.equal(await isSupervised('none'), false);
});

test('isSupervised launchd parses state', async () => {
  assert.equal(
    await isSupervised('launchd', async () => ({ stdout: '\tstate = running\n' })),
    true,
  );
  assert.equal(
    await isSupervised('launchd', async () => ({ stdout: '\tstate = exited\n' })),
    false,
  );
});

test('none manager falls back to pidfile', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'svc-'));
  try {
    assert.equal(await restartDaemon({ userData, mgr: 'none' }), 'not-running');
    const child = spawn('sleep', ['30'], { stdio: 'ignore' });
    const exited = new Promise((r) => child.once('exit', r));
    mkdirSync(join(userData, 'state', 'runtime'), { recursive: true });
    writeFileSync(pidFilePath(userData), String(child.pid));
    assert.equal(await restartDaemon({ userData, mgr: 'none' }), 'sigterm');
    await exited;
  } finally {
    rmSync(userData, { recursive: true, force: true });
  }
});
