import { unlink } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

export async function mcpUninstall() {
  const home = homedir();
  if (platform() === 'darwin') {
    const plistPath = join(home, 'Library/LaunchAgents/io.robin-assistant.mcp.plist');
    try {
      await unlink(plistPath);
      console.log(`removed: ${plistPath}`);
    } catch {
      console.log('plist not present');
    }
  } else if (platform() === 'linux') {
    const unitPath = join(home, '.config/systemd/user/robin-mcp.service');
    try {
      await unlink(unitPath);
      console.log(`removed: ${unitPath}`);
    } catch {
      console.log('unit not present');
    }
  }
  console.log(
    'CLAUDE.md / GEMINI.md left in place; remove the fenced robin-mcp section manually if desired',
  );
}
