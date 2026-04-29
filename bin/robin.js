#!/usr/bin/env node
// Robin CLI entry point. Lightweight dispatcher; sub-commands live in
// system/scripts/. Heavy modules are lazy-imported to keep cold start tight.

const HELP = `Robin — personal AI assistant CLI

usage:
  robin run <name> [--force | --dry-run | --no-lock]
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
  robin update                        # post-pull check: config migrate + pending migrations + skeleton sync + validate

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

  if (cmd === 'run') {
    const cli = await import('../system/scripts/jobs/cli.js');
    return cli.cmdRun(rest);
  }
  if (cmd === 'job') {
    const cli = await import('../system/scripts/jobs/cli.js');
    return cli.cmdJob(rest);
  }
  if (cmd === 'jobs') {
    const cli = await import('../system/scripts/jobs/cli.js');
    return cli.dispatchJobs(rest);
  }
  if (cmd === 'update') {
    const { runStartupCheck } = await import('../system/scripts/startup-check.js');
    const r = await runStartupCheck();
    for (const f of r.findings) console.log(`${f.level}: ${f.message}`);
    if (r.findings.some((f) => f.level === 'FATAL')) process.exit(1);
    if (r.findings.length === 0) console.log('Nothing to do.');
    process.exit(0);
  }

  process.stderr.write(`unknown command: ${cmd}\n${HELP}`);
  process.exit(2);
}

main().catch((err) => {
  process.stderr.write(`robin: ${err.stack || err.message}\n`);
  process.exit(1);
});
