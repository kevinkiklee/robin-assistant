import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readDaemonState } from '../../daemon/state.js';
import { agentsMdContent, mergeAgentsMdContent } from '../../install/agents-md.js';
import { generateLaunchdPlist } from '../../install/launchd-plist.js';
import { generateSystemdUnit } from '../../install/systemd-unit.js';
import { paths } from '../../runtime/home.js';
import { parseArgs } from '../args.js';
import { mcpEnsureRunning } from './mcp-ensure-running.js';

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

function which(cmd) {
  const result = spawnSync('which', [cmd], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

function autoSupervise(plistPath, unitPath) {
  if (platform() === 'darwin') {
    // Unload first (idempotent — silently ignore if not loaded), then load.
    spawnSync('launchctl', ['unload', plistPath], { stdio: 'ignore' });
    const load = spawnSync('launchctl', ['load', plistPath], { stdio: 'inherit' });
    if (load.status === 0) {
      console.log('launchd: loaded — daemon will be restarted on crash');
    } else {
      console.log('launchd: load failed (non-fatal); run manually:');
      console.log(`  launchctl load ${plistPath}`);
    }
  } else if (platform() === 'linux') {
    const reload = spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' });
    const enable = spawnSync('systemctl', ['--user', 'enable', 'robin-mcp.service'], {
      stdio: 'inherit',
    });
    if (reload.status === 0 && enable.status === 0) {
      console.log('systemd: enabled — daemon will be restarted on crash');
    } else {
      console.log('systemd: enable failed (non-fatal); run manually:');
      console.log('  systemctl --user daemon-reload');
      console.log('  systemctl --user enable robin-mcp.service');
    }
  }
}

function autoRegister(port) {
  for (const host of ['claude', 'gemini']) {
    if (!which(host)) continue;
    console.log(`registering Robin with ${host}...`);
    // Idempotent remove — silently ignore if not registered.
    spawnSync(host, ['mcp', 'remove', 'robin'], { stdio: 'ignore' });
    const add = spawnSync(
      host,
      ['mcp', 'add', '--transport', 'sse', 'robin', `http://127.0.0.1:${port}/sse`],
      { stdio: 'inherit' },
    );
    if (add.status !== 0) {
      console.log(`  ${host}: registration failed (non-fatal)`);
    }
  }
}

export async function mcpInstall(argv) {
  const args = parseArgs(argv);
  const noAgentsMd = args.flags['no-agents-md'] === true;
  const noSupervise = args.flags['no-supervise'] === true;
  const noRegister = args.flags['no-register'] === true;
  const noStart = args.flags['no-start'] === true;
  const here = dirname(fileURLToPath(import.meta.url));
  const serverPath = resolve(here, '../../daemon/server.js');
  const nodeBin = process.execPath;
  const home = homedir();

  let plistPath = null;
  let unitPath = null;

  // 1. Generate + write supervisor file.
  if (platform() === 'darwin') {
    const plistDir = join(home, 'Library/LaunchAgents');
    await mkdir(plistDir, { recursive: true });
    plistPath = join(plistDir, 'io.robin-assistant.mcp.plist');
    const xml = generateLaunchdPlist({
      label: 'io.robin-assistant.mcp',
      nodeBin,
      serverPath,
      home,
    });
    await writeFile(plistPath, xml, 'utf8');
    console.log(`installed launchd plist: ${plistPath}`);
  } else if (platform() === 'linux') {
    const unitDir = join(home, '.config/systemd/user');
    await mkdir(unitDir, { recursive: true });
    unitPath = join(unitDir, 'robin-mcp.service');
    const txt = generateSystemdUnit({ nodeBin, serverPath });
    await writeFile(unitPath, txt, 'utf8');
    console.log(`installed systemd user unit: ${unitPath}`);
  } else {
    console.error(`platform ${platform()} not supported in 2b; daemon supervision unavailable`);
    process.exit(1);
  }

  // 2. Auto-supervise.
  if (!noSupervise) {
    autoSupervise(plistPath, unitPath);
  } else {
    console.log('skipping supervisor load (--no-supervise)');
  }

  // 3. Auto-start daemon.
  let port = null;
  if (!noStart) {
    try {
      await mcpEnsureRunning();
      // 4. Read port from .daemon.state.
      const p = paths();
      const state = await readDaemonState(p.daemonState);
      if (state?.port) port = state.port;
    } catch (e) {
      console.log(`daemon failed to start (non-fatal): ${e.message}`);
    }
  } else {
    console.log('skipping daemon start (--no-start)');
  }

  // 5. Auto-register with hosts.
  if (!noRegister) {
    if (port) {
      autoRegister(port);
    } else {
      console.log('skipping host registration (no daemon port available)');
    }
  } else {
    console.log('skipping host registration (--no-register)');
  }

  // 6. Write/merge CLAUDE.md + GEMINI.md.
  if (!noAgentsMd) {
    const claudePath = join(home, '.claude/CLAUDE.md');
    const geminiPath = join(home, '.gemini/GEMINI.md');
    await writeMergedAgentsMd(claudePath);
    await writeMergedAgentsMd(geminiPath);
  }

  // 7. Print summary.
  console.log('');
  if (port) {
    console.log(`Robin MCP daemon running on http://127.0.0.1:${port}/sse`);
  }
  if (noRegister || !port) {
    console.log('To register manually:');
    console.log(`  claude mcp add --transport sse robin http://127.0.0.1:${port ?? '<port>'}/sse`);
    console.log(`  gemini mcp add --transport sse robin http://127.0.0.1:${port ?? '<port>'}/sse`);
    if (!port) console.log('Get the port with: robin mcp status');
  }
}
