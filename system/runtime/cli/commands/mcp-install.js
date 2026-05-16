import { spawnSync } from 'node:child_process';
import { chmodSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { readDaemonState } from '../../../config/daemon-state.js';
import {
  packageRootDir,
  paths,
  recordHostTouchpoint,
  robinHome,
} from '../../../config/data-store.js';
import { readConfig, writeConfig } from '../../../config/paths.js';
import { bindPort } from '../../daemon/port.js';
import { refreshAgentsMdFiles } from '../../install/agents-md-refresh.js';
import { generateLaunchdPlist } from '../../install/launchd-plist.js';
import { generateSystemdUnit } from '../../install/systemd-unit.js';
import { parseArgs } from '../args.js';
import { mcpEnsureRunning } from './mcp-ensure-running.js';
import { mcpStop } from './mcp-stop.js';

/**
 * Ensure `config.json` has a persisted `mcp.port`. Without it, every daemon
 * restart binds a fresh ephemeral port, which silently invalidates the URL
 * we just registered in `~/.claude.json` (and Gemini's settings.json). Pick
 * once at install, persist, then the daemon reads it back at boot. Port
 * collisions degrade gracefully to ephemeral (see daemon/port.js).
 */
async function ensureMcpPort() {
  const cfg = (await readConfig()) ?? {};
  if (Number.isInteger(cfg?.mcp?.port)) return cfg.mcp.port;
  // Reserve a port: bind ephemeral, read the kernel-assigned port, free it.
  // Race: another process can grab it before the daemon does, in which case
  // bindPort() falls back to ephemeral and the host URL goes stale until
  // the next install. Acceptable — the steady-state behaviour is stable.
  const { server, port } = await bindPort(0);
  await new Promise((r) => server.close(r));
  cfg.mcp = { ...(cfg.mcp ?? {}), port };
  await writeConfig(cfg);
  console.log(`reserved mcp port ${port} in config.json`);
  return port;
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

  // Reserve mcp.port BEFORE supervising/starting the daemon, so the
  // forthcoming daemon process reads the persisted preference at boot and
  // binds the same port every restart.
  await ensureMcpPort();

  // Stop any pre-existing daemon (detached *or* launchd-managed) before
  // touching the supervisor. mcpStop SIGTERMs the PID from
  // `runtime/daemon/.state` and polls until exit, so by the time we hit
  // `launchctl load` the lock is free and the fresh daemon acquires it on
  // first try — no EALREADY bounce through launchd's 10-second KeepAlive
  // throttle.
  await mcpStop();

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
      // 0600 parity with surreal-install: the plist embeds the absolute
      // node path + ROBIN_HOME, which can be sensitive on shared machines.
      // launchd reads it as the loading user, so 0600 doesn't break load.
      // writeFileSync's `mode` only applies on CREATE — on re-install over
      // an existing file the permission would silently revert to whatever
      // the prior write produced (commonly 0644 under default umask).
      // Explicit chmodSync closes that gap.
      () => {
        writeFileSync(plistPath, xml, { mode: 0o600 });
        chmodSync(plistPath, 0o600);
      },
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
      // Same writeFileSync mode-on-create caveat as the plist branch above.
      () => {
        writeFileSync(unitPath, txt, { mode: 0o600 });
        chmodSync(unitPath, 0o600);
      },
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
      // 4. Read port from runtime/daemon/.state.
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
    const results = await refreshAgentsMdFiles({ targets: [claudePath, geminiPath] });
    for (const r of results) console.log(`${r.action} ${r.path}`);
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
