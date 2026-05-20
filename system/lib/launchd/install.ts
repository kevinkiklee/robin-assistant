import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { resolveRunnableCommand } from '../mcp-config/write.ts';
import { resolveUserDataDir } from '../paths.ts';

export const LAUNCHD_LABEL = 'io.robin-assistant.daemon';

export interface DaemonLaunchdSpec {
  /** Absolute path to the node binary that will run the CLI. */
  nodePath: string;
  /** Absolute path to the compiled CLI entry (dist/surfaces/cli/index.js). */
  cliPath: string;
  /** Absolute path to ROBIN_USER_DATA_DIR. */
  userDataDir: string;
  /** PATH inherited by launchd children. Defaults to the installer's PATH. */
  path?: string;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function renderDaemonPlist(spec: DaemonLaunchdSpec): string {
  const logPath = join(spec.userDataDir, 'observability', 'logs', 'daemon.log');
  const path = spec.path ?? process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin';
  const args = [spec.nodePath, spec.cliPath, 'daemon', '--foreground'];
  const argLines = args.map((a) => `    <string>${escapeXml(a)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(LAUNCHD_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
${argLines}
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(spec.userDataDir)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${escapeXml(homedir())}</string>
    <key>ROBIN_USER_DATA_DIR</key>
    <string>${escapeXml(spec.userDataDir)}</string>
    <key>PATH</key>
    <string>${escapeXml(path)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(logPath)}</string>
</dict>
</plist>
`;
}

export function plistPath(opts?: { home?: string; label?: string }): string {
  const home = opts?.home ?? homedir();
  const label = opts?.label ?? LAUNCHD_LABEL;
  return join(home, 'Library', 'LaunchAgents', `${label}.plist`);
}

function requireDarwin(): void {
  if (platform() !== 'darwin') {
    throw new Error(`launchd is only supported on macOS (current: ${platform()})`);
  }
}

export interface InstallResult {
  plistPath: string;
  loaded: boolean;
  alreadyLoaded: boolean;
}

/**
 * Write the plist to ~/Library/LaunchAgents and load it via launchctl.
 * Idempotent: if already loaded, unloads first so the new plist is picked up.
 */
export function installDaemonLaunchd(
  spec: DaemonLaunchdSpec,
  opts?: { home?: string; skipLoad?: boolean },
): InstallResult {
  requireDarwin();
  const path = plistPath({ home: opts?.home });
  mkdirSync(dirname(path), { recursive: true });
  mkdirSync(join(spec.userDataDir, 'observability', 'logs'), { recursive: true });
  writeFileSync(path, renderDaemonPlist(spec));
  if (opts?.skipLoad) return { plistPath: path, loaded: false, alreadyLoaded: false };
  let alreadyLoaded = false;
  try {
    execFileSync('launchctl', ['unload', path], { stdio: 'pipe' });
    alreadyLoaded = true;
  } catch {
    // Not loaded yet — first install or stale plist; fine.
  }
  execFileSync('launchctl', ['load', path], { stdio: 'pipe' });
  return { plistPath: path, loaded: true, alreadyLoaded };
}

export interface UninstallResult {
  plistPath: string;
  unloaded: boolean;
  removed: boolean;
}

export function uninstallDaemonLaunchd(opts?: { home?: string }): UninstallResult {
  requireDarwin();
  const path = plistPath({ home: opts?.home });
  if (!existsSync(path)) return { plistPath: path, unloaded: false, removed: false };
  let unloaded = false;
  try {
    execFileSync('launchctl', ['unload', path], { stdio: 'pipe' });
    unloaded = true;
  } catch {
    // not loaded
  }
  unlinkSync(path);
  return { plistPath: path, unloaded, removed: true };
}

/** Build a spec from the running CLI process. Requires a built dist/. */
export function buildDaemonSpecFromEnv(opts?: { userDataDir?: string }): DaemonLaunchdSpec {
  const cliPath = resolveRunnableCommand(process.argv[1] ?? '');
  const nodePath = process.execPath;
  const userDataDir = opts?.userDataDir ?? resolveUserDataDir();
  return { nodePath, cliPath, userDataDir };
}
