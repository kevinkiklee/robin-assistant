import { spawnSync } from 'node:child_process';
import { existsSync, rmSync, unlinkSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import {
  deletePointer,
  forgetHostTouchpoint,
  readHostIntegrations,
  robinHome,
} from '../../../config/data-store.js';
import { uninstallHooksFromSettings } from '../../install/hooks-settings.js';
import { uninstallPreCommit } from '../../install/pre-commit.js';
import { parseArgs } from '../args.js';
import { input } from '../prompts.js';

function which(cmd) {
  const result = spawnSync('which', [cmd], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

async function defaultStopDaemon() {
  let manifest;
  try {
    manifest = await readHostIntegrations();
  } catch {
    return;
  }
  for (const e of manifest.entries) {
    if (e.kind === 'launchd-plist' && platform() === 'darwin') {
      spawnSync('launchctl', ['bootout', `gui/${process.getuid()}`, e.path], { stdio: 'pipe' });
    }
    if (e.kind === 'systemd-unit' && platform() === 'linux') {
      spawnSync('systemctl', ['--user', 'stop', e.unit ?? 'robin-mcp.service'], { stdio: 'pipe' });
    }
  }
}

export async function uninstall(argv = [], deps = {}) {
  const args = parseArgs(argv);
  const strict = args.flags.strict === true;
  const purge = args.flags.purge === true;
  const yes = args.flags.yes === true;
  const interactive =
    typeof deps.interactive === 'boolean' ? deps.interactive : Boolean(process.stdin.isTTY);
  const prompt = deps.prompt ?? input;
  const stopDaemon = deps.stopDaemon ?? defaultStopDaemon;

  // 1. Stop the daemon.
  await stopDaemon();

  // 2. Walk the manifest in reverse-install order.
  let manifest;
  try {
    manifest = await readHostIntegrations();
  } catch (e) {
    console.error(`uninstall: cannot read host-integrations.json: ${e.message}`);
    if (strict) process.exit(1);
    manifest = { entries: [] };
  }
  const entries = [...manifest.entries].reverse();
  for (const entry of entries) {
    try {
      switch (entry.kind) {
        case 'claude-hooks':
        case 'gemini-hooks':
          // Use hooks-settings's removal logic (it handles malformed JSON gracefully).
          await uninstallHooksFromSettings({ homeDir: homedir() });
          break;
        case 'launchd-plist':
          if (existsSync(entry.path)) unlinkSync(entry.path);
          break;
        case 'systemd-unit':
          if (existsSync(entry.path)) unlinkSync(entry.path);
          spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'pipe' });
          break;
        case 'git-precommit-hook':
          if (existsSync(entry.path)) {
            await uninstallPreCommit({
              cwd: entry.path.replace(/\/\.git\/hooks\/pre-commit$/, ''),
            });
          }
          break;
      }
      await forgetHostTouchpoint({ kind: entry.kind, path: entry.path });
    } catch (err) {
      console.warn(`uninstall: ${entry.kind} at ${entry.path} — ${err.message}`);
      if (strict) {
        console.error('uninstall: --strict abort after first failure');
        process.exit(1);
      }
      // Best-effort: also forget the touchpoint so a re-run isn't stuck retrying it.
      try {
        await forgetHostTouchpoint({ kind: entry.kind, path: entry.path });
      } catch {
        // ignore
      }
    }
  }

  // 3. Deregister MCP server from hosts that are on PATH (orthogonal cleanup not in manifest).
  for (const host of ['claude', 'gemini']) {
    if (which(host)) {
      spawnSync(host, ['mcp', 'remove', 'robin'], { stdio: 'pipe' });
    }
  }

  // 4. Home dir prompt.
  const home = (() => {
    try {
      return robinHome();
    } catch {
      return null;
    }
  })();
  if (home && existsSync(home)) {
    let remove = false;
    if (purge) remove = true;
    else if (interactive && !yes) {
      const a = (
        await prompt(
          `Robin's data folder is at ${home}.\nWhat should we do with it?\n  [k] keep    (default — you can reinstall later and point at it)\n  [r] remove  (irreversible)\nChoose [k/r]: `,
        )
      )
        .trim()
        .toLowerCase();
      remove = a === 'r' || a === 'remove';
    }
    if (remove) {
      rmSync(home, { recursive: true, force: true });
      console.log(`removed ${home}`);
    } else {
      console.log(`Robin data preserved at ${home}`);
    }
  }

  // 5. Delete the pointer last.
  deletePointer();
  console.log('Robin uninstalled.');
}
