import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import type { DaemonLaunchdSpec } from '../launchd/install.ts';
import { writeUserDataPointer } from '../paths.ts';
import { type ExecFn, SYSTEMD_UNIT } from './manager.ts';

const DAEMON_TZ = 'America/Chicago';

export function unitPath(opts?: { home?: string }): string {
  return join(opts?.home ?? homedir(), '.config', 'systemd', 'user', SYSTEMD_UNIT);
}

/** Daemon-only environment file; the only place CLAUDE_CODE_OAUTH_TOKEN lives. */
export function daemonEnvPath(userDataDir: string): string {
  return join(userDataDir, 'config', 'secrets', 'daemon.env');
}

/** systemd command-line quoting: wrap whitespace-bearing args in double quotes. */
function quoteArg(a: string): string {
  if (!/\s/.test(a)) return a;
  return `"${a.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** `Environment=` takes the rest of the line; only quote when the assignment has whitespace. */
function envLine(key: string, value: string): string {
  const assignment = `${key}=${value}`;
  return `Environment=${/\s/.test(assignment) ? quoteArg(assignment) : assignment}`;
}

export function renderDaemonUnit(spec: DaemonLaunchdSpec, opts?: { home?: string }): string {
  const home = opts?.home ?? homedir();
  const logPath = join(spec.userDataDir, 'observability', 'logs', 'daemon.log');
  const path = spec.path ?? process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin';
  const exec = [spec.nodePath, spec.cliPath, 'daemon', '--foreground'].map(quoteArg).join(' ');
  return `[Unit]
Description=Robin daemon

[Service]
Type=simple
WorkingDirectory=${spec.userDataDir}
ExecStart=${exec}
${envLine('HOME', home)}
${envLine('ROBIN_USER_DATA_DIR', spec.userDataDir)}
${envLine('PATH', path)}
${envLine('TZ', DAEMON_TZ)}
EnvironmentFile=-${daemonEnvPath(spec.userDataDir)}
Restart=always
RestartSec=5
# process: detached children (agent runs, auto-land probation) must outlive a restart, as under launchd.
KillMode=process
TimeoutStopSec=30
StandardOutput=append:${logPath}
StandardError=append:${logPath}

[Install]
WantedBy=default.target
`;
}

async function defaultExec(cmd: string, args: string[]): Promise<{ stdout: string }> {
  const { execFile } = await import('node:child_process');
  return new Promise((resolve, reject) => {
    execFile(cmd, args, (err, stdout) => (err ? reject(err) : resolve({ stdout })));
  });
}

async function isLingerEnabled(exec: ExecFn): Promise<boolean> {
  try {
    const { stdout } = await exec('loginctl', ['show-user', userInfo().username, '-p', 'Linger']);
    return /^Linger=yes\s*$/m.test(stdout);
  } catch {
    return false;
  }
}

export interface SystemdInstallResult {
  unitPath: string;
  loaded: boolean;
  lingerEnabled: boolean;
}

/** Write the user unit, reload systemd, enable, and restart. Idempotent. */
export async function installDaemonSystemd(
  spec: DaemonLaunchdSpec,
  opts?: { home?: string; exec?: ExecFn; skipLoad?: boolean },
): Promise<SystemdInstallResult> {
  const exec = opts?.exec ?? defaultExec;
  const path = unitPath({ home: opts?.home });
  mkdirSync(dirname(path), { recursive: true });
  // systemd's `append:` won't create parent directories.
  mkdirSync(join(spec.userDataDir, 'observability', 'logs'), { recursive: true });
  writeFileSync(path, renderDaemonUnit(spec, { home: opts?.home }));
  writeUserDataPointer(spec.userDataDir, { home: opts?.home });
  const lingerEnabled = await isLingerEnabled(exec);
  if (opts?.skipLoad) return { unitPath: path, loaded: false, lingerEnabled };
  await exec('systemctl', ['--user', 'daemon-reload']);
  await exec('systemctl', ['--user', 'enable', SYSTEMD_UNIT]);
  // restart (not --now) so a rewritten unit reaches an already-running daemon.
  await exec('systemctl', ['--user', 'restart', SYSTEMD_UNIT]);
  return { unitPath: path, loaded: true, lingerEnabled };
}

export async function uninstallDaemonSystemd(opts?: {
  home?: string;
  exec?: ExecFn;
}): Promise<{ unitPath: string; removed: boolean }> {
  const exec = opts?.exec ?? defaultExec;
  const path = unitPath({ home: opts?.home });
  if (!existsSync(path)) return { unitPath: path, removed: false };
  try {
    await exec('systemctl', ['--user', 'disable', '--now', SYSTEMD_UNIT]);
  } catch {
    // not enabled / not running
  }
  unlinkSync(path);
  try {
    await exec('systemctl', ['--user', 'daemon-reload']);
  } catch {
    // best effort
  }
  return { unitPath: path, removed: true };
}
