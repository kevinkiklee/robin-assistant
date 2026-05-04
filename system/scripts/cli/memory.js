// `robin memory ...` CLI surface. Routes to per-op modules in
// system/scripts/memory/ via subprocess so each module keeps its existing
// CLI shape (some load with side-effects at import). Subprocess-per-call
// preserves cold-start: the dispatcher itself stays sub-100ms and only
// the matched module's code is loaded into the child process.
//
// Pattern: same dispatch-by-string-match style as system/scripts/cli/jobs.js
// and system/scripts/cli/watches.js. Pure printf + ANSI; no chalk.

import { spawn } from 'node:child_process';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MEMORY_DIR = resolve(__dirname, '..', 'memory');

const HELP = `usage: robin memory <op>

ops:
  regenerate-links       Rebuild user-data/memory/LINKS.md from current link graph
  index-entities         Regenerate user-data/memory/ENTITIES.md (auto-entity index)
  lint                   Audit memory for contradictions, dead links, orphans
  densify                Convert dense paragraphs into wiki-link-rich form
  prune-preview          Show what would be archived under TTL pruning
  prune-execute          Execute the TTL prune (moves stale files to archive/)
`;

// Map of op → script file (lazy-resolved per call; no top-level imports
// of the op modules themselves).
const OPS = {
  'regenerate-links': 'regenerate-links.js',
  'index-entities': 'index-entities.js',
  lint: 'lint.js',
  densify: 'densify-wiki.js',
  'prune-preview': 'prune-preview.js',
  'prune-execute': 'prune-execute.js',
};

function runOp(scriptFile, rest) {
  return new Promise((resolveP) => {
    const child = spawn(process.execPath, [join(MEMORY_DIR, scriptFile), ...rest], {
      stdio: 'inherit',
      env: process.env,
    });
    child.on('exit', (code, signal) => {
      if (signal) resolveP(1);
      else resolveP(code ?? 0);
    });
    child.on('error', (err) => {
      process.stderr.write(`robin memory: failed to spawn ${scriptFile}: ${err.message}\n`);
      resolveP(1);
    });
  });
}

export async function dispatchMemory(args) {
  const op = args[0];
  const rest = args.slice(1);

  if (op === undefined || op === '-h' || op === '--help' || op === 'help') {
    process.stdout.write(HELP);
    return 0;
  }

  const scriptFile = OPS[op];
  if (!scriptFile) {
    process.stderr.write(`robin memory: unknown op: ${op}\n`);
    process.stderr.write(HELP);
    return 2;
  }

  return runOp(scriptFile, rest);
}

export { HELP as MEMORY_HELP };
