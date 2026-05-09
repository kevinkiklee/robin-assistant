import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentsMdContent, mergeAgentsMdContent } from '../../install/agents-md.js';
import { generateLaunchdPlist } from '../../install/launchd-plist.js';
import { generateSystemdUnit } from '../../install/systemd-unit.js';
import { parseArgs } from '../args.js';

async function readOrEmpty(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return '';
    throw e;
  }
}

async function writeMergedAgentsMd(path) {
  await mkdir(dirname(path), { recursive: true });
  const existing = await readOrEmpty(path);
  const merged = mergeAgentsMdContent(existing, agentsMdContent());
  await writeFile(path, merged, 'utf8');
  console.log(`updated ${path}`);
}

export async function mcpInstall(argv) {
  const args = parseArgs(argv);
  const noAgentsMd = args.flags['no-agents-md'] === true;
  const here = dirname(fileURLToPath(import.meta.url));
  const serverPath = resolve(here, '../../daemon/server.js');
  const nodeBin = process.execPath;
  const home = homedir();

  if (platform() === 'darwin') {
    const plistDir = join(home, 'Library/LaunchAgents');
    await mkdir(plistDir, { recursive: true });
    const plistPath = join(plistDir, 'io.robin-assistant.mcp.plist');
    const xml = generateLaunchdPlist({
      label: 'io.robin-assistant.mcp',
      nodeBin,
      serverPath,
      home,
    });
    await writeFile(plistPath, xml, 'utf8');
    console.log(`installed launchd plist: ${plistPath}`);
    console.log('To enable supervision (restart on crash):');
    console.log('  launchctl load ~/Library/LaunchAgents/io.robin-assistant.mcp.plist');
  } else if (platform() === 'linux') {
    const unitDir = join(home, '.config/systemd/user');
    await mkdir(unitDir, { recursive: true });
    const unitPath = join(unitDir, 'robin-mcp.service');
    const txt = generateSystemdUnit({ nodeBin, serverPath });
    await writeFile(unitPath, txt, 'utf8');
    console.log(`installed systemd user unit: ${unitPath}`);
    console.log('To enable supervision (restart on crash):');
    console.log('  systemctl --user enable robin-mcp');
    console.log('  loginctl enable-linger $(whoami)  # cross-session activation');
  } else {
    console.error(`platform ${platform()} not supported in 2b; daemon supervision unavailable`);
    process.exit(1);
  }

  if (!noAgentsMd) {
    const claudePath = join(home, '.claude/CLAUDE.md');
    const geminiPath = join(home, '.gemini/GEMINI.md');
    await writeMergedAgentsMd(claudePath);
    await writeMergedAgentsMd(geminiPath);
    console.log('');
    console.log('Register Robin with your hosts:');
    console.log('  claude mcp add --transport sse robin http://127.0.0.1:<port>/sse');
    console.log('  gemini mcp add --transport sse robin http://127.0.0.1:<port>/sse');
    console.log('Get the port with: robin mcp status');
  }
}
