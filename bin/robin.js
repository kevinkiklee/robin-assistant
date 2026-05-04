#!/usr/bin/env node
// Robin CLI entry point. Lightweight dispatcher; sub-commands live in
// system/scripts/. Heavy modules are lazy-imported to keep cold start tight.

const HELP = `Robin — personal AI assistant CLI

usage:
  robin init                          [--target <dir>] [--no-prompt]
  robin run <name> [--force | --dry-run | --no-lock]
  robin run --due                     # run all enabled, due jobs
  robin job <acquire | release> <name>
  robin jobs                          # alias for "robin jobs list"
  robin jobs list                     [--json]
  robin jobs status [<name>]          [--json]
  robin jobs logs <name>              [--full | --tail=N | --list]
  robin jobs upcoming
  robin jobs enable <name>
  robin jobs disable <name>
  robin jobs sync                     [--force | --json]
  robin jobs validate [<name>]
  robin update                        # post-pull check: config migrate + pending migrations + scaffold sync + validate
  robin link <path>                   [--dry-run]
  robin watch add "<topic>"           [--cadence daily|weekly|hourly] [--query <q>] [--notify]
  robin watch list
  robin watch enable <id>
  robin watch disable <id>
  robin watch tail [<id>]             [--n=10]
  robin watch run <id>                [--dry-run | --bootstrap]
  robin recall [--json] <term> [<term> ...]
  robin trust [status | pending | history [--days N] | class <slug>]
  robin regenerate-memory-index            [--check]

env:
  ROBIN_WORKSPACE  override the workspace directory
  ROBIN_BIN        absolute path to the robin CLI (used for scheduler entries)
  ROBIN_NO_NOTIFY  disable native OS notifications
`;

// `env` is documented as part of main's contract for the e2e harness; sub-commands
// still read `process.env` directly. The harness (system/tests/lib/scenario.js)
// mutates and restores `process.env` around each main() call, so per-scenario
// env overlays propagate without threading the param through every sub-command.
async function main(argv = process.argv.slice(2), env = process.env) {
  const cmd = argv[0];
  const rest = argv.slice(1);

  if (!cmd || cmd === '-h' || cmd === '--help' || cmd === 'help') {
    process.stdout.write(HELP);
    return { exitCode: 0 };
  }

  if (cmd === 'init') {
    const { cmdInit } = await import('../system/scripts/cli/init.js');
    await cmdInit(rest);
    return { exitCode: 0 };
  }
  if (cmd === 'run') {
    const cli = await import('../system/scripts/cli/jobs.js');
    await cli.cmdRun(rest);
    return { exitCode: 0 };
  }
  if (cmd === 'job') {
    const cli = await import('../system/scripts/cli/jobs.js');
    await cli.cmdJob(rest);
    return { exitCode: 0 };
  }
  if (cmd === 'jobs') {
    const cli = await import('../system/scripts/cli/jobs.js');
    await cli.dispatchJobs(rest);
    return { exitCode: 0 };
  }
  if (cmd === 'update') {
    const { runPreflight } = await import('../system/scripts/lib/preflight.js');
    const r = await runPreflight();
    for (const f of r.findings) console.log(`${f.level}: ${f.message}`);
    if (r.findings.some((f) => f.level === 'FATAL')) return { exitCode: 1 };
    if (r.findings.length === 0) console.log('Nothing to do.');
    return { exitCode: 0 };
  }
  if (cmd === 'link') {
    const { cmdLink } = await import('../system/scripts/wiki-graph/lib/cli-link.js');
    return { exitCode: await cmdLink(rest) };
  }
  if (cmd === 'watch') {
    const { dispatchWatch } = await import('../system/scripts/cli/watches.js');
    await dispatchWatch(rest);
    return { exitCode: 0 };
  }

  if (cmd === 'regenerate-memory-index') {
    const { writeMemoryIndex, checkMemoryIndex } = await import('../system/scripts/memory/regenerate-index.js');
    const { resolveCliWorkspaceDir } = await import('../system/scripts/lib/workspace-root.js');
    const ws = resolveCliWorkspaceDir();
    const memoryDir = join(ws, 'user-data', 'memory');
    if (rest.includes('--check')) {
      if (!checkMemoryIndex(memoryDir)) {
        process.stderr.write('memory/INDEX.md is out of date. Run regenerate-memory-index to fix.\n');
        return { exitCode: 1 };
      }
      process.stdout.write('memory/INDEX.md is up to date.\n');
      return { exitCode: 0 };
    }
    writeMemoryIndex(memoryDir);
    process.stdout.write('memory/INDEX.md regenerated.\n');
    return { exitCode: 0 };
  }

  if (cmd === 'trust') {
    const { runTrust } = await import('../system/scripts/cli/trust.js');
    const r = await runTrust(rest);
    return { exitCode: r.exitCode };
  }

  if (cmd === 'recall') {
    if (rest.length === 0) {
      process.stderr.write('Usage: robin recall [--json] <term> [<term> ...]\n');
      return { exitCode: 1 };
    }
    const wantsJson = rest[0] === '--json' && rest.shift();
    if (rest.length === 0) {
      process.stderr.write('Usage: robin recall [--json] <term> [<term> ...]\n');
      return { exitCode: 1 };
    }
    const { recall, formatRecallHits } = await import('../system/scripts/memory/lib/recall.js');
    const { resolveCliWorkspaceDir } = await import('../system/scripts/lib/workspace-root.js');
    const ws = resolveCliWorkspaceDir();
    const result = recall(ws, rest);
    if (wantsJson) {
      console.log(JSON.stringify(result));
    } else {
      const formatted = formatRecallHits(result);
      console.log(formatted || 'No matches.');
    }
    return { exitCode: 0 };
  }

  process.stderr.write(`unknown command: ${cmd}\n${HELP}`);
  return { exitCode: 2 };
}

export { main };

// Subprocess shell guard — runs only when invoked directly, not when imported.
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';

const isMain = process.argv[1]
  && (() => {
    try {
      return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
    } catch {
      return false;
    }
  })();

if (isMain) {
  main()
    .then(({ exitCode }) => process.exit(exitCode))
    .catch((err) => {
      process.stderr.write(`robin: ${err.stack || err.message}\n`);
      process.exit(1);
    });
}
