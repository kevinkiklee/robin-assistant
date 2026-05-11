import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { readDaemonState } from '../../daemon/state.js';
import { agentsMdContent, mergeAgentsMdContent } from '../../install/agents-md.js';
import { generateLaunchdPlist } from '../../install/launchd-plist.js';
import { generateSystemdUnit } from '../../install/systemd-unit.js';
import {
  packageRootDir,
  paths,
  recordHostTouchpoint,
  robinHome,
} from '../../../config/data-store.js';
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

// Single-pass DB read for all AGENTS.md inputs. Combined to avoid sequential
// rocksdb open+close cycles, which can deadlock under the @surrealdb/node v3
// close-hang. Fail-soft: any error returns the per-field "unavailable" value.
async function readDbDataForAgentsMd() {
  try {
    const { ensureHome } = await import('../../../config/data-store.js');
    const { connect, close, defaultDbUrl } = await import('../../../data/db/client.js');
    const { listAllJobs } = await import('../../../cognition/jobs/db.js');
    const { getCommStyle } = await import('../../../cognition/jobs/comm-style.js');
    const { getCalibration } = await import('../../../cognition/jobs/predictions.js');
    await ensureHome();
    const db = await connect({ engine: await defaultDbUrl() });
    try {
      const jobs = await listAllJobs(db);
      const commStyle = await getCommStyle(db);
      const calibration = await getCalibration(db);
      return { jobs, commStyle, calibration };
    } finally {
      await close(db);
    }
  } catch {
    return { jobs: undefined, commStyle: null, calibration: null };
  }
}

async function writeMergedAgentsMd(path, jobs, commStyle, calibration) {
  await mkdir(dirname(path), { recursive: true });
  const existing = await readOrEmpty(path);
  const merged = mergeAgentsMdContent(existing, agentsMdContent({ jobs, commStyle, calibration }));
  await writeFile(path, merged, 'utf8');
  console.log(`updated ${path}`);
}

function which(cmd) {
  const result = spawnSync('which', [cmd], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

function autoSupervise(plistPath, _unitPath) {
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
  const home = homedir();
  const packageRoot = packageRootDir();
  const currentRobinHome = robinHome();

  let plistPath = null;
  let unitPath = null;

  // 1. Generate + write supervisor file.
  if (platform() === 'darwin') {
    const plistDir = join(home, 'Library/LaunchAgents');
    await mkdir(plistDir, { recursive: true });
    plistPath = join(plistDir, 'io.robin-assistant.mcp.plist');
    const xml = generateLaunchdPlist({ packageRoot, robinHome: currentRobinHome });
    await recordHostTouchpoint(
      {
        kind: 'launchd-plist',
        path: plistPath,
        expectedHome: currentRobinHome,
        label: 'io.robin-assistant.mcp',
      },
      () => writeFileSync(plistPath, xml, { mode: 0o644 }),
    );
    console.log(`installed launchd plist: ${plistPath}`);
  } else if (platform() === 'linux') {
    const unitDir = join(home, '.config/systemd/user');
    await mkdir(unitDir, { recursive: true });
    unitPath = join(unitDir, 'robin-mcp.service');
    const txt = generateSystemdUnit({ packageRoot, robinHome: currentRobinHome });
    await recordHostTouchpoint(
      {
        kind: 'systemd-unit',
        path: unitPath,
        expectedHome: currentRobinHome,
        label: 'robin-mcp.service',
      },
      () => writeFileSync(unitPath, txt, { mode: 0o644 }),
    );
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
      const state = await readDaemonState(paths.data.daemonState());
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
    const { jobs, commStyle, calibration } = await readDbDataForAgentsMd();
    await writeMergedAgentsMd(claudePath, jobs, commStyle, calibration);
    await writeMergedAgentsMd(geminiPath, jobs, commStyle, calibration);
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
