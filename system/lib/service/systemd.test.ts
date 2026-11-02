import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  installDaemonSystemd,
  renderDaemonUnit,
  uninstallDaemonSystemd,
  unitPath,
} from './systemd.ts';

const spec = {
  nodePath: '/usr/bin/node',
  cliPath: '/opt/robin/dist/cli.js',
  userDataDir: '/srv/ud',
  path: '/usr/bin:/bin',
};

function fakeExec(linger: string) {
  const calls: Array<[string, string[]]> = [];
  const exec = async (cmd: string, args: string[]) => {
    calls.push([cmd, args]);
    if (cmd === 'loginctl') return { stdout: `Linger=${linger}\n` };
    return { stdout: '' };
  };
  return { calls, exec };
}

describe('renderDaemonUnit', () => {
  it('renders TZ and env file', () => {
    const u = renderDaemonUnit(spec, { home: '/home/robin' });
    assert.ok(u.includes('Environment=TZ=America/Chicago'));
    assert.ok(u.includes('EnvironmentFile=-/srv/ud/config/secrets/daemon.env'));
    assert.ok(u.includes('Environment=HOME=/home/robin'));
  });
  it('ExecStart', () => {
    const u = renderDaemonUnit(spec, { home: '/home/robin' });
    assert.ok(u.includes('ExecStart=/usr/bin/node /opt/robin/dist/cli.js daemon --foreground\n'));
  });
  it('quotes paths with spaces', () => {
    const u = renderDaemonUnit(
      { ...spec, cliPath: '/opt/my robin/cli.js', userDataDir: '/srv/my data' },
      { home: '/home/robin' },
    );
    assert.ok(u.includes('WorkingDirectory=/srv/my data\n'));
    assert.ok(u.includes('ExecStart=/usr/bin/node "/opt/my robin/cli.js" daemon --foreground\n'));
    assert.ok(u.includes('Environment=ROBIN_USER_DATA_DIR=/srv/my data\n') === false);
    assert.ok(u.includes('Environment="ROBIN_USER_DATA_DIR=/srv/my data"\n'));
    assert.ok(u.includes('StandardOutput=append:/srv/my data/observability/logs/daemon.log\n'));
  });
  it('no token in unit', () => {
    assert.ok(!renderDaemonUnit(spec).includes('CLAUDE_CODE_OAUTH_TOKEN'));
  });
});

describe('installDaemonSystemd', () => {
  it('calls systemctl and writes the unit', async () => {
    const home = mkdtempSync(join(tmpdir(), 'sd-'));
    const ud = mkdtempSync(join(tmpdir(), 'sd-ud-'));
    const { calls, exec } = fakeExec('yes');
    const r = await installDaemonSystemd({ ...spec, userDataDir: ud }, { home, exec });
    const sc = calls.filter(([c]) => c === 'systemctl');
    assert.deepEqual(sc, [
      ['systemctl', ['--user', 'daemon-reload']],
      ['systemctl', ['--user', 'enable', '--now', 'robin-daemon.service']],
    ]);
    assert.equal(r.unitPath, unitPath({ home }));
    assert.ok(existsSync(r.unitPath));
    assert.ok(existsSync(join(ud, 'observability', 'logs')));
    assert.ok(readFileSync(r.unitPath, 'utf8').includes('[Service]'));
    assert.equal(r.loaded, true);
  });
  it('reports linger state', async () => {
    for (const [v, want] of [
      ['no', false],
      ['yes', true],
    ] as const) {
      const home = mkdtempSync(join(tmpdir(), 'sd-'));
      const ud = mkdtempSync(join(tmpdir(), 'sd-ud-'));
      const r = await installDaemonSystemd(
        { ...spec, userDataDir: ud },
        { home, exec: fakeExec(v).exec },
      );
      assert.equal(r.lingerEnabled, want);
    }
  });
  it('linger false when loginctl fails; skipLoad skips systemctl', async () => {
    const home = mkdtempSync(join(tmpdir(), 'sd-'));
    const ud = mkdtempSync(join(tmpdir(), 'sd-ud-'));
    const calls: string[] = [];
    const exec = async (cmd: string) => {
      calls.push(cmd);
      throw new Error('boom');
    };
    const r = await installDaemonSystemd(
      { ...spec, userDataDir: ud },
      { home, exec, skipLoad: true },
    );
    assert.equal(r.loaded, false);
    assert.ok(!calls.includes('systemctl'));
    assert.equal(r.lingerEnabled, false);
  });
});

describe('uninstallDaemonSystemd', () => {
  it('disables, deletes, reloads', async () => {
    const home = mkdtempSync(join(tmpdir(), 'sd-'));
    const ud = mkdtempSync(join(tmpdir(), 'sd-ud-'));
    await installDaemonSystemd(
      { ...spec, userDataDir: ud },
      { home, exec: fakeExec('yes').exec, skipLoad: true },
    );
    const { calls, exec } = fakeExec('yes');
    const r = await uninstallDaemonSystemd({ home, exec });
    assert.equal(r.removed, true);
    assert.ok(!existsSync(r.unitPath));
    assert.deepEqual(calls, [
      ['systemctl', ['--user', 'disable', '--now', 'robin-daemon.service']],
      ['systemctl', ['--user', 'daemon-reload']],
    ]);
  });
});
