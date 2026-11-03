import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  installDaemonSystemd,
  renderDaemonUnit,
  renderTimer,
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
  it('renders TZ from the instance operator.yaml, and the env file', () => {
    const ud = mkdtempSync(join(tmpdir(), 'robin-unit-tz-'));
    mkdirSync(join(ud, 'config'), { recursive: true });
    writeFileSync(join(ud, 'config', 'operator.yaml'), 'timezone: Pacific/Auckland\n');
    const u = renderDaemonUnit({ ...spec, userDataDir: ud }, { home: '/home/robin' });
    assert.ok(u.includes('Environment=TZ=Pacific/Auckland'));
    assert.ok(u.includes(`EnvironmentFile=-${ud}/config/secrets/daemon.env`));
    assert.ok(u.includes('Environment=HOME=/home/robin'));
  });
  it('TZ falls back to ROBIN_TZ when the instance sets no zone', () => {
    const prev = process.env.ROBIN_TZ;
    process.env.ROBIN_TZ = 'Africa/Nairobi';
    try {
      const u = renderDaemonUnit(spec, { home: '/home/robin' });
      assert.ok(u.includes('Environment=TZ=Africa/Nairobi'));
    } finally {
      if (prev === undefined) delete process.env.ROBIN_TZ;
      else process.env.ROBIN_TZ = prev;
    }
    const u = renderDaemonUnit(spec, { home: '/home/robin' });
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
  it('uses KillMode=process and no network-online ordering', () => {
    const u = renderDaemonUnit(spec);
    assert.ok(u.includes('KillMode=process\n'));
    assert.ok(!u.includes('network-online'));
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
      ['systemctl', ['--user', 'enable', 'robin-daemon.service']],
      ['systemctl', ['--user', 'enable', '--now', 'robin-watchdog.timer', 'robin-reap.timer']],
      ['systemctl', ['--user', 'restart', 'robin-daemon.service']],
    ]);
    assert.ok(existsSync(join(home, '.config', 'systemd', 'user', 'robin-watchdog.timer')));
    assert.ok(existsSync(join(home, '.config', 'systemd', 'user', 'robin-reap.service')));
    assert.equal(r.unitPath, unitPath({ home }));
    assert.ok(existsSync(r.unitPath));
    assert.ok(existsSync(join(ud, 'observability', 'logs')));
    assert.ok(readFileSync(r.unitPath, 'utf8').includes('[Service]'));
    assert.equal(r.loaded, true);
  });
  it('writes the user-data pointer under the given home', async () => {
    const home = mkdtempSync(join(tmpdir(), 'sd-'));
    const ud = mkdtempSync(join(tmpdir(), 'sd-ud-'));
    await installDaemonSystemd(
      { ...spec, userDataDir: ud },
      { home, exec: fakeExec('yes').exec, skipLoad: true },
    );
    const pointer = join(home, '.config', 'robin', 'user-data-dir');
    assert.equal(readFileSync(pointer, 'utf8').trim(), ud);
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
      ['systemctl', ['--user', 'disable', '--now', 'robin-watchdog.timer', 'robin-reap.timer']],
      ['systemctl', ['--user', 'disable', '--now', 'robin-daemon.service']],
      ['systemctl', ['--user', 'daemon-reload']],
    ]);
  });
});

describe('renderTimer', () => {
  const t = renderTimer({
    name: 'robin-watchdog',
    description: 'Robin liveness watchdog',
    onCalendar: '*:0/15',
    execStart: ['/usr/bin/node', '/opt/my robin/cli.js', 'watchdog'],
  });
  it('service is a oneshot with quoted argv', () => {
    assert.ok(t.service.includes('Type=oneshot\n'));
    assert.ok(t.service.includes('ExecStart=/usr/bin/node "/opt/my robin/cli.js" watchdog\n'));
  });
  it('timer is persistent with the calendar', () => {
    assert.ok(t.timer.includes('OnCalendar=*:0/15\n'));
    assert.ok(t.timer.includes('Persistent=true\n'));
    assert.ok(t.timer.includes('WantedBy=timers.target'));
  });
});

describe('timers install and uninstall', () => {
  it('reloads once; uninstall removes the timer files', async () => {
    const home = mkdtempSync(join(tmpdir(), 'sd-'));
    const ud = mkdtempSync(join(tmpdir(), 'sd-ud-'));
    const { calls, exec } = fakeExec('yes');
    await installDaemonSystemd({ ...spec, userDataDir: ud }, { home, exec });
    assert.equal(calls.filter(([c, a]) => c === 'systemctl' && a[1] === 'daemon-reload').length, 1);
    const dir = join(home, '.config', 'systemd', 'user');
    const wd = readFileSync(join(dir, 'robin-watchdog.service'), 'utf8');
    assert.ok(wd.includes(`Environment=ROBIN_USER_DATA_DIR=${ud}`));
    assert.ok(wd.includes('ExecStart=/usr/bin/node /opt/robin/dist/cli.js watchdog\n'));
    assert.ok(readFileSync(join(dir, 'robin-reap.timer'), 'utf8').includes('OnCalendar=hourly'));
    await uninstallDaemonSystemd({ home, exec });
    assert.ok(!existsSync(join(dir, 'robin-watchdog.timer')));
    assert.ok(!existsSync(join(dir, 'robin-reap.service')));
    assert.ok(
      calls.some(
        ([c, a]) => c === 'systemctl' && a.includes('disable') && a.includes('robin-reap.timer'),
      ),
    );
  });
});

describe('uninstall without a daemon unit', () => {
  it('still removes the timers', async () => {
    const home = mkdtempSync(join(tmpdir(), 'sd-'));
    const ud = mkdtempSync(join(tmpdir(), 'sd-ud-'));
    await installDaemonSystemd(
      { ...spec, userDataDir: ud },
      { home, exec: fakeExec('yes').exec, skipLoad: true },
    );
    const dir = join(home, '.config', 'systemd', 'user');
    unlinkSync(join(dir, 'robin-daemon.service'));
    const { calls, exec } = fakeExec('yes');
    const r = await uninstallDaemonSystemd({ home, exec });
    assert.equal(r.removed, false);
    assert.ok(!existsSync(join(dir, 'robin-watchdog.timer')));
    assert.ok(!existsSync(join(dir, 'robin-reap.service')));
    assert.ok(calls.some(([, a]) => a.includes('robin-reap.timer')));
  });
});
