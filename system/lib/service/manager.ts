import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { isProcessAlive, readPidfile } from '../../kernel/runtime/pidfile.ts';
import { LAUNCHD_LABEL } from '../launchd/install.ts';
import { pidFilePath } from '../paths.ts';

export type ServiceManager = 'launchd' | 'systemd' | 'none';

export const SYSTEMD_UNIT = 'robin-daemon.service';

export type ExecFn = (cmd: string, args: string[]) => Promise<{ stdout: string }>;

const execFileAsync = promisify(execFile);
const defaultExec: ExecFn = async (cmd, args) => {
  const { stdout } = await execFileAsync(cmd, args);
  return { stdout: String(stdout) };
};

/** True when a systemd user manager answers (a "degraded" state still counts). */
function probeSystemctl(): boolean {
  try {
    execFileSync('systemctl', ['--user', 'is-system-running'], { stdio: 'pipe' });
    return true;
  } catch (err) {
    const e = err as { code?: string; stdout?: Buffer | string };
    if (e.code === 'ENOENT') return false;
    return String(e.stdout ?? '').trim().length > 0;
  }
}

export function detectServiceManager(opts?: {
  platform?: string;
  hasSystemctl?: () => boolean;
}): ServiceManager {
  const plat = opts?.platform ?? process.platform;
  if (plat === 'darwin') return 'launchd';
  if (plat === 'linux') return (opts?.hasSystemctl ?? probeSystemctl)() ? 'systemd' : 'none';
  return 'none';
}

export function restartArgv(
  mgr: ServiceManager,
  uid: number = process.getuid?.() ?? 501,
): string[] | null {
  if (mgr === 'launchd') return ['launchctl', 'kickstart', '-k', `gui/${uid}/${LAUNCHD_LABEL}`];
  if (mgr === 'systemd') return ['systemctl', '--user', 'restart', SYSTEMD_UNIT];
  return null;
}

const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export function restartShellCommand(
  mgr: ServiceManager,
  opts: { uid?: number; pidfile: string },
): string {
  const argv = restartArgv(mgr, opts.uid);
  if (argv) return argv.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : shQuote(a))).join(' ');
  return `kill -TERM "$(cat ${shQuote(opts.pidfile)})"`;
}

export async function isSupervised(
  mgr: ServiceManager,
  exec: ExecFn = defaultExec,
): Promise<boolean> {
  try {
    if (mgr === 'launchd') {
      const uid = process.getuid?.() ?? 501;
      const { stdout } = await exec('launchctl', ['print', `gui/${uid}/${LAUNCHD_LABEL}`]);
      return /state\s*=\s*(running|active|waiting)/i.test(stdout);
    }
    if (mgr === 'systemd') {
      const { stdout } = await exec('systemctl', ['--user', 'is-active', SYSTEMD_UNIT]);
      return stdout.trim() === 'active';
    }
  } catch {
    // not supervised
  }
  return false;
}

/** Supervisor restart when supervised, else SIGTERM to the pidfile's process. Never throws. */
export async function restartDaemon(opts: {
  userData: string;
  mgr?: ServiceManager;
  exec?: ExecFn;
}): Promise<'supervisor' | 'sigterm' | 'not-running'> {
  const mgr = opts.mgr ?? detectServiceManager();
  const exec = opts.exec ?? defaultExec;
  const argv = restartArgv(mgr);
  if (argv && (await isSupervised(mgr, exec))) {
    try {
      await exec(argv[0], argv.slice(1));
      return 'supervisor';
    } catch {
      // fall through to SIGTERM as a best-effort backup
    }
  }
  const pid = readPidfile(pidFilePath(opts.userData));
  if (!pid || !isProcessAlive(pid)) return 'not-running';
  try {
    process.kill(pid, 'SIGTERM');
    return 'sigterm';
  } catch {
    return 'not-running';
  }
}
