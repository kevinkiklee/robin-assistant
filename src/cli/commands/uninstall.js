import { spawnSync } from 'node:child_process';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { uninstallHooksFromSettings } from '../../install/hooks-settings.js';
import { packageRootDir } from '../../runtime/home.js';
import { mcpStop } from './mcp-stop.js';
import { mcpUninstall } from './mcp-uninstall.js';

function which(cmd) {
  const result = spawnSync('which', [cmd], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

export async function uninstall() {
  console.log('Stopping daemon...');
  await mcpStop();

  // Remove robin hook entries from ~/.claude/settings.json + ~/.gemini/settings.json.
  // Foreign entries are preserved.
  try {
    const { removedByHost } = await uninstallHooksFromSettings({
      homeDir: homedir(),
      packageRoot: packageRootDir(),
    });
    for (const [host, count] of Object.entries(removedByHost)) {
      const settingsPath =
        host === 'claude' ? '~/.claude/settings.json' : `~/.${host}/settings.json`;
      if (count > 0) {
        console.log(`removed ${count} robin hook entries from ${settingsPath}`);
      }
    }
  } catch (e) {
    console.warn(`hook uninstall failed (continuing): ${e.message}`);
  }

  // Unregister from hosts that are on PATH.
  for (const host of ['claude', 'gemini']) {
    if (which(host)) {
      console.log(`Unregistering from ${host}...`);
      spawnSync(host, ['mcp', 'remove', 'robin'], { stdio: 'inherit' });
    }
  }

  // Unload supervisor.
  const home = homedir();
  if (platform() === 'darwin') {
    const plistPath = join(home, 'Library/LaunchAgents/io.robin-assistant.mcp.plist');
    spawnSync('launchctl', ['unload', plistPath], { stdio: 'inherit' });
  } else if (platform() === 'linux') {
    spawnSync('systemctl', ['--user', 'disable', 'robin-mcp.service'], { stdio: 'inherit' });
  }

  await mcpUninstall();
  console.log('');
  console.log('Robin uninstalled. ~/.robin/db data preserved; remove manually if desired.');
}
