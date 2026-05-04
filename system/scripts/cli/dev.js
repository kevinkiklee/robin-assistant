// `robin dev ...` CLI surface. Hidden from default `robin --help` —
// developer-only diagnostics, one-time migrations, and the destructive
// reset. Spawns each script as a subprocess so they retain their existing
// argv shape without needing a `main(argv)` refactor.
//
// Pattern: same dispatch-by-string-match style as system/scripts/cli/memory.js
// and system/scripts/cli/discord.js. Pure printf + ANSI; no chalk.

import { spawn } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..');

const HELP = `usage: robin dev <op>

ops:
  measure-tokens          Measure prompt token usage
  measure-prefix-bloat    Measure prefix-cache bloat
  check-plugin-prefix     Validate plugin prefix conventions
  check-protocol-triggers Audit protocol trigger phrases
  check-doc-paths         Verify doc cross-references resolve
  golden-session          Run the golden-session diagnostic
  tool-call-stats         Aggregate tool-call statistics
  migrate-auto-memory     One-time migration: drain auto-memory to user-data
  reset                   DESTRUCTIVE: reset workspace state
  analyze-finances        Run the financial analysis diagnostic
`;

const OPS = {
  'measure-tokens':          'system/scripts/diagnostics/measure-tokens.js',
  'measure-prefix-bloat':    'system/scripts/diagnostics/measure-prefix-bloat.js',
  'check-plugin-prefix':     'system/scripts/diagnostics/check-plugin-prefix.js',
  'check-protocol-triggers': 'system/scripts/diagnostics/check-protocol-triggers.js',
  'check-doc-paths':         'system/scripts/diagnostics/check-doc-paths.js',
  'golden-session':          'system/scripts/diagnostics/golden-session.js',
  'tool-call-stats':         'system/scripts/diagnostics/tool-call-stats.js',
  'migrate-auto-memory':     'system/scripts/capture/auto-memory.js',
  'reset':                   'system/scripts/cli/reset.js',
  'analyze-finances':        'system/scripts/diagnostics/analyze-finances.js',
};

function runOp(scriptPath, rest) {
  return new Promise((resolveP) => {
    const child = spawn(process.execPath, [scriptPath, ...rest], { stdio: 'inherit' });
    child.on('error', (err) => {
      process.stderr.write(`robin dev: failed to spawn ${scriptPath}: ${err.message}\n`);
      resolveP(1);
    });
    child.on('exit', (code, signal) => {
      if (signal) { resolveP(1); return; }
      resolveP(code ?? 0);
    });
  });
}

export async function dispatchDev(args) {
  const op = args[0];

  if (!op || op === '-h' || op === '--help' || op === 'help') {
    process.stdout.write(HELP);
    return 0;
  }

  if (!Object.hasOwn(OPS, op)) {
    process.stderr.write(`robin dev: unknown op: ${op}\n${HELP}`);
    return 2;
  }

  const scriptPath = join(REPO_ROOT, OPS[op]);
  return await runOp(scriptPath, args.slice(1));
}

export { HELP as DEV_HELP };
