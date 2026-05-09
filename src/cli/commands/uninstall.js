import { spawnSync } from 'node:child_process';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { mcpStop } from './mcp-stop.js';
import { mcpUninstall } from './mcp-uninstall.js';

function which(cmd) {
  const result = spawnSync('which', [cmd], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

export async function uninstall() {
  console.log('Stopping daemon...');
  await mcpStop();

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
