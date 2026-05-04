// `robin discord ...` CLI surface. Routes to standalone scripts under the
// instance's user-data/runtime/scripts/ (scaffolded from system/scaffold/
// during install) via subprocess. Each underlying script keeps its existing
// CLI shape; subprocess-per-call preserves cold-start of the dispatcher
// itself and only loads the matched script's code into the child process.
//
// Pattern: same dispatch-by-string-match style as system/scripts/cli/memory.js
// and system/scripts/cli/jobs.js. Pure printf + ANSI; no chalk.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolveCliWorkspaceDir } from '../lib/workspace-root.js';

const HELP = `usage: robin discord <op>

ops:
  install           Install the discord bot service
  uninstall         Remove the discord bot service
  auth              Run the discord OAuth flow
  status            Print bot service status
  health            Probe bot connectivity
`;

// Map of op → { script, extraArgs }. Scripts are resolved at call-time
// against `<workspace>/user-data/runtime/scripts/` (scaffolded at install).
const OPS = {
  install: { script: 'discord-bot-install.js', extraArgs: [] },
  uninstall: { script: 'discord-bot-install.js', extraArgs: ['--uninstall'] },
  auth: { script: 'auth-discord.js', extraArgs: [] },
  status: { script: 'discord-bot-status.js', extraArgs: [] },
  health: { script: 'discord-bot-health.js', extraArgs: [] },
};

function runOp(scriptPath, args) {
  return new Promise((resolveP) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      stdio: 'inherit',
      env: process.env,
    });
    child.on('exit', (code, signal) => {
      if (signal) resolveP(1);
      else resolveP(code ?? 0);
    });
    child.on('error', (err) => {
      process.stderr.write(`robin discord: spawn failed — ${err.message}\n`);
      resolveP(1);
    });
  });
}

export async function dispatchDiscord(args) {
  const op = args[0];
  const rest = args.slice(1);

  if (op === undefined || op === '-h' || op === '--help' || op === 'help') {
    process.stdout.write(HELP);
    return 0;
  }

  const entry = OPS[op];
  if (!entry) {
    process.stderr.write(`robin discord: unknown op: ${op}\n`);
    process.stderr.write(HELP);
    return 2;
  }

  const ws = resolveCliWorkspaceDir();
  const scriptPath = join(ws, 'user-data/runtime/scripts', entry.script);
  if (!existsSync(scriptPath)) {
    process.stderr.write(
      `robin discord: ${entry.script} not found at ${scriptPath}\n` +
        `  Did you run \`npm install\` to scaffold user-data?\n`
    );
    return 1;
  }

  return runOp(scriptPath, [...entry.extraArgs, ...rest]);
}

export { HELP as DISCORD_HELP };
