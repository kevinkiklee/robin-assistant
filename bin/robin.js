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

env:
  ROBIN_WORKSPACE  override the workspace directory
  ROBIN_BIN        absolute path to the robin CLI (used for scheduler entries)
  ROBIN_NO_NOTIFY  disable native OS notifications
`;

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const rest = argv.slice(1);

  if (!cmd || cmd === '-h' || cmd === '--help' || cmd === 'help') {
    process.stdout.write(HELP);
    process.exit(0);
  }

  if (cmd === 'init') {
    const { cmdInit } = await import('../system/scripts/cli/init.js');
    return cmdInit(rest);
  }
  if (cmd === 'run') {
    const cli = await import('../system/scripts/cli/jobs.js');
    return cli.cmdRun(rest);
  }
  if (cmd === 'job') {
    const cli = await import('../system/scripts/cli/jobs.js');
    return cli.cmdJob(rest);
  }
  if (cmd === 'jobs') {
    const cli = await import('../system/scripts/cli/jobs.js');
    return cli.dispatchJobs(rest);
  }
  if (cmd === 'update') {
    const { runPreflight } = await import('../system/scripts/lib/preflight.js');
    const r = await runPreflight();
    for (const f of r.findings) console.log(`${f.level}: ${f.message}`);
    if (r.findings.some((f) => f.level === 'FATAL')) process.exit(1);
    if (r.findings.length === 0) console.log('Nothing to do.');
    process.exit(0);
  }
  if (cmd === 'link') {
    const { cmdLink } = await import('../system/scripts/lib/wiki-graph/cli-link.js');
    process.exit(await cmdLink(rest));
  }
  if (cmd === 'watch') {
    const { dispatchWatch } = await import('../system/scripts/cli/watches.js');
    return dispatchWatch(rest);
  }

  if (cmd === 'recall') {
    if (rest.length === 0) {
      process.stderr.write('Usage: robin recall [--json] <term> [<term> ...]\n');
      process.exit(1);
    }
    const wantsJson = rest[0] === '--json' && rest.shift();
    if (rest.length === 0) {
      process.stderr.write('Usage: robin recall [--json] <term> [<term> ...]\n');
      process.exit(1);
    }
    const { recall, formatRecallHits } = await import('../system/scripts/lib/recall.js');
    const ws = process.env.ROBIN_WORKSPACE || process.cwd();
    const result = recall(ws, rest);
    if (wantsJson) {
      console.log(JSON.stringify(result));
    } else {
      const formatted = formatRecallHits(result);
      console.log(formatted || 'No matches.');
    }
    return;
  }

  process.stderr.write(`unknown command: ${cmd}\n${HELP}`);
  process.exit(2);
}

main().catch((err) => {
  process.stderr.write(`robin: ${err.stack || err.message}\n`);
  process.exit(1);
});
