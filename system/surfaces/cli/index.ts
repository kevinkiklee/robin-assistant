#!/usr/bin/env node
import { argv, exit } from 'node:process';
import { Daemon } from '../../kernel/runtime/daemon.ts';
import { buildRobinMcpEntry, upsertUserScopeMcp } from '../../lib/mcp-config/write.ts';
import { printDoctorHuman, runDoctor } from './doctor.ts';
import { runIncognito, runOffline, runOnline, runPause, runResume, runStatus } from './power.ts';

const VERSION = '3.0.0-alpha.0';

function extractFlag(args: string[], prefix: string): string | undefined {
  const found = args.find((a) => a.startsWith(prefix));
  return found?.slice(prefix.length);
}

function printHelp(): void {
  // biome-ignore lint/suspicious/noConsole: CLI output
  console.log(`robin ${VERSION}

USAGE
  robin <command> [options]

COMMANDS
  agent "<goal>"    Run a guarded agentic task (--handler=A..L | --write [defaults to A], --cwd=, --max-turns=N, --budget=N, --force)
  beliefs review    List pending belief candidates (alias: list; --status= --limit=)
  beliefs promote   Promote a candidate into a belief: beliefs promote <id> [--reason=...]
  beliefs reject    Reject a candidate: beliefs reject <id> [--reason=...]
  daemon            Run the Robin daemon (called by launchd; not for habitual use)
  daemon install    Install + load the launchd agent so the daemon autostarts
  daemon uninstall  Unload + remove the launchd agent
  db backup         Back up the database (--path=<path> optional)
  db restore        Restore database from backup (--from=<path>)
  db vacuum         Vacuum the database
  doctor            Diagnose daemon + environment
  import            Import NDJSON dumps from content/imported-from-<source>/
  ingest-docs       Index content/knowledge/ + content/profile/ *.md for recall (idempotent; --json)
  init              One-time setup (interactive)
  integrations      Per-integration health table (status, last attempt, errors)
  pause             Pause scheduled work
  primer            Print the session-start primer (--write [--path=<p>] to materialize)
  reindex           Backfill embeddings for events_content rows missing one
  resume            Resume scheduled work
  incognito         Disable session capture (--for 1h optional)
  offline           Block outbound network
  online            Restore outbound network
  status            Show current state
  upgrade           Apply pending schema migrations (--dry-run optional)
  mcp core          Run the robin-core MCP server (called by Claude Code via stdio)
  mcp extension     Run the robin-extension MCP server (called by Claude Code via stdio)
  mcp install       Add/replace robin in ~/.claude.json
  hooks install     Add the SessionEnd hook to ~/.claude/settings.json so every Claude Code session gets captured automatically
  hooks uninstall   Remove the SessionEnd hook from ~/.claude/settings.json
  publish           Publish a markdown file to the web (--source <path> [--slug <s>] [--mode default|overwrite|as-new|delete] [--dry-run])
  published         List published pages from this Robin instance
  reauth <name>     Refresh an integration's OAuth refresh token (gmail | google_calendar). Opens consent in browser, captures the new token, writes it to .env, signals the daemon. Use --port=<n> if 8089 is taken.
  --version
  --help
`);
}

async function main(): Promise<void> {
  const args = argv.slice(2);
  const cmd = args[0];

  switch (cmd) {
    case undefined:
    case '--help':
    case '-h':
    case 'help': {
      printHelp();
      exit(0);
      break;
    }

    case '--version':
    case '-v': {
      // biome-ignore lint/suspicious/noConsole: CLI output
      console.log(VERSION);
      exit(0);
      break;
    }

    case 'agent': {
      const { runAgentCommand } = await import('./agent.ts');
      await runAgentCommand(args.slice(1));
      return;
    }

    case 'beliefs': {
      const sub = args[1];
      const beliefs = await import('./beliefs.ts');
      const { runBeliefsReview, runBeliefsPromote, runBeliefsReject } = beliefs;
      const limitFlag = extractFlag(args, '--limit=');
      const reason = extractFlag(args, '--reason=');
      const statusFlag = extractFlag(args, '--status=');
      const status =
        statusFlag === 'pending' || statusFlag === 'promoted' || statusFlag === 'rejected'
          ? statusFlag
          : undefined;
      const opts: import('./beliefs.ts').BeliefsCliOptions = {
        ...(status ? { status } : {}),
        ...(limitFlag ? { limit: Number(limitFlag) } : {}),
        ...(reason ? { reason } : {}),
      };
      if (sub === undefined || sub === 'review' || sub === 'list') {
        runBeliefsReview(opts);
        exit(0);
      }
      if (sub === 'promote' || sub === 'reject') {
        const idArg = args[2];
        const id = idArg ? Number(idArg) : NaN;
        if (!Number.isInteger(id)) {
          // biome-ignore lint/suspicious/noConsole: CLI output
          console.error(`usage: robin beliefs ${sub} <id> [--reason=...]`);
          exit(2);
        }
        try {
          if (sub === 'promote') runBeliefsPromote(id, opts);
          else runBeliefsReject(id, opts);
          exit(0);
        } catch (err) {
          // biome-ignore lint/suspicious/noConsole: CLI output
          console.error(err instanceof Error ? err.message : String(err));
          exit(1);
        }
      }
      // biome-ignore lint/suspicious/noConsole: CLI output
      console.error(`Unknown beliefs subcommand: ${sub}`);
      exit(2);
      break;
    }

    case 'doctor': {
      if (args.includes('--emit-runbook')) {
        const { emitRunbook } = await import('./doctor.ts');
        const r = emitRunbook({ write: args.includes('--write') });
        // biome-ignore lint/suspicious/noConsole: CLI output
        console.log(`Runbook ${r.existed ? 'updated' : 'created'} at ${r.path}`);
        exit(0);
      }
      const json = args.includes('--json');
      const report = await runDoctor({ version: VERSION });
      if (json) {
        // biome-ignore lint/suspicious/noConsole: CLI output
        console.log(JSON.stringify(report, null, 2));
      } else {
        printDoctorHuman(report);
      }
      exit(report.summary.exit_code);
      break;
    }

    case 'daemon': {
      const sub = args[1];
      if (sub === 'install') {
        const { installDaemonLaunchd, buildDaemonSpecFromEnv } = await import(
          '../../lib/launchd/install.ts'
        );
        try {
          const spec = buildDaemonSpecFromEnv();
          const r = installDaemonLaunchd(spec);
          // biome-ignore lint/suspicious/noConsole: CLI output
          console.log(`${r.alreadyLoaded ? 'Reloaded' : 'Loaded'} launchd agent at ${r.plistPath}`);
          // biome-ignore lint/suspicious/noConsole: CLI output
          console.log(`  Daemon: ${spec.nodePath} ${spec.cliPath} daemon --foreground`);
          // biome-ignore lint/suspicious/noConsole: CLI output
          console.log(`  Data:   ${spec.userDataDir}`);
          exit(0);
        } catch (err) {
          // biome-ignore lint/suspicious/noConsole: CLI output
          console.error(err instanceof Error ? err.message : String(err));
          exit(1);
        }
      }
      if (sub === 'uninstall') {
        const { uninstallDaemonLaunchd } = await import('../../lib/launchd/install.ts');
        try {
          const r = uninstallDaemonLaunchd();
          // biome-ignore lint/suspicious/noConsole: CLI output
          console.log(
            r.removed
              ? `Removed launchd agent at ${r.plistPath}`
              : `No launchd agent at ${r.plistPath}`,
          );
          exit(0);
        } catch (err) {
          // biome-ignore lint/suspicious/noConsole: CLI output
          console.error(err instanceof Error ? err.message : String(err));
          exit(1);
        }
      }
      const fg = args.includes('--foreground') || args.includes('-f');
      const daemon = new Daemon();
      // Register a simple test handler so end-to-end tests can verify the loop
      daemon.registerHandler('test.noop', async () => {
        /* no-op */
      });
      await daemon.start({ foreground: fg });
      return;
    }

    case 'init': {
      const { runInit } = await import('./init.ts');
      await runInit({
        yes: args.includes('--yes') || args.includes('-y'),
        profile: extractFlag(args, '--profile='),
        noModels: args.includes('--no-models'),
        noLaunchd: args.includes('--no-launchd'),
      });
      exit(0);
      break;
    }

    case 'pause': {
      runPause();
      exit(0);
      break;
    }

    case 'primer': {
      const { runPrimer } = await import('./primer.ts');
      runPrimer({ write: args.includes('--write'), path: extractFlag(args, '--path=') });
      exit(0);
      break;
    }

    case 'resume': {
      runResume();
      exit(0);
      break;
    }

    case 'incognito': {
      const dur =
        extractFlag(args, '--for=') ?? (args[1] && !args[1].startsWith('-') ? args[1] : undefined);
      runIncognito(dur);
      exit(0);
      break;
    }

    case 'offline': {
      runOffline();
      exit(0);
      break;
    }

    case 'online': {
      runOnline();
      exit(0);
      break;
    }

    case 'status': {
      runStatus(args.includes('--json'));
      exit(0);
      break;
    }

    case 'db': {
      const sub = args[1];
      const { runDbBackup, runDbRestore, runDbVacuum } = await import('./db.ts');
      if (sub === 'backup') {
        runDbBackup({ path: extractFlag(args, '--path=') });
        exit(0);
      }
      if (sub === 'restore') {
        const path = extractFlag(args, '--from=') ?? args[2];
        if (!path) {
          console.error('usage: robin db restore --from=<path>');
          exit(2);
        }
        runDbRestore({ path });
        exit(0);
      }
      if (sub === 'vacuum') {
        runDbVacuum();
        exit(0);
      }
      console.error(`Unknown db subcommand: ${sub}`);
      exit(2);
      break;
    }

    case 'import': {
      const { runImport, printImportHuman, ALL_KINDS } = await import('./import.ts');
      const dir = args[1] && !args[1].startsWith('-') ? args[1] : extractFlag(args, '--dir=');
      if (!dir) {
        console.error(
          'usage: robin import <dir> [--kinds=events,entities,...] [--limit=N] [--dry-run] [--json]',
        );
        exit(2);
      }
      const kindsFlag = extractFlag(args, '--kinds=');
      const limitFlag = extractFlag(args, '--limit=');
      const kinds = kindsFlag
        ? (kindsFlag.split(',').filter((k) => ALL_KINDS.includes(k as never)) as typeof ALL_KINDS)
        : undefined;
      const report = await runImport({
        dir: dir as string,
        kinds,
        limit: limitFlag ? Number(limitFlag) : undefined,
        dryRun: args.includes('--dry-run'),
      });
      if (args.includes('--json')) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        printImportHuman(report);
      }
      exit(report.errors.length > 0 ? 1 : 0);
      break;
    }

    case 'ingest-docs': {
      const { runIngestDocs, printIngestDocsHuman } = await import('./ingest-docs.ts');
      const r = runIngestDocs();
      if (args.includes('--json')) {
        // biome-ignore lint/suspicious/noConsole: CLI output
        console.log(JSON.stringify(r, null, 2));
      } else {
        printIngestDocsHuman(r);
      }
      exit(0);
      break;
    }

    case 'integrations': {
      const { runIntegrationsReport, printIntegrationsHuman } = await import('./integrations.ts');
      const report = runIntegrationsReport();
      if (args.includes('--json')) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        printIntegrationsHuman(report);
      }
      exit(0);
      break;
    }

    case 'reindex': {
      const { runReindex, printReindexHuman } = await import('./reindex.ts');
      const limitFlag = extractFlag(args, '--limit=');
      const batchFlag = extractFlag(args, '--batch=');
      const idsFlag = extractFlag(args, '--ids=');
      const ids = idsFlag
        ? idsFlag
            .split(',')
            .map((s) => Number(s.trim()))
            .filter((n) => Number.isFinite(n))
        : undefined;
      const report = await runReindex({
        limit: limitFlag ? Number(limitFlag) : undefined,
        force: args.includes('--force'),
        ids,
        batchSize: batchFlag ? Number(batchFlag) : 50,
        onProgress: ({ processed, embedded, failed }) => {
          process.stderr.write(`  ${processed} processed (${embedded} ok, ${failed} fail)\n`);
        },
      });
      if (args.includes('--json')) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        printReindexHuman(report);
      }
      exit(report.errors.length > 0 && report.embedded === 0 ? 1 : 0);
      break;
    }

    case 'upgrade': {
      const { runUpgrade } = await import('./upgrade.ts');
      runUpgrade({ dryRun: args.includes('--dry-run'), skipBackup: args.includes('--no-backup') });
      exit(0);
      break;
    }

    case 'publish': {
      const { runPublishCli } = await import('./publish.ts');
      await runPublishCli(args.slice(1));
      return;
    }

    case 'published': {
      const { runPublishedCli } = await import('./publish.ts');
      await runPublishedCli(args.slice(1));
      return;
    }

    case 'reauth': {
      const integration = args[1];
      if (!integration) {
        // biome-ignore lint/suspicious/noConsole: CLI output
        console.error('Usage: robin reauth <integration>   (gmail | google_calendar)');
        exit(2);
      }
      const portFlag = extractFlag(args, '--port=');
      const { runReauth } = await import('./reauth.ts');
      try {
        await runReauth({
          integration,
          port: portFlag ? Number(portFlag) : undefined,
        });
        exit(0);
      } catch (err) {
        // biome-ignore lint/suspicious/noConsole: CLI output
        console.error(`reauth failed: ${err instanceof Error ? err.message : String(err)}`);
        exit(1);
      }
      break;
    }

    case 'hooks': {
      const sub = args[1];
      if (sub === 'install') {
        const { installSessionEndHook } = await import('../../lib/claude-hooks/install.ts');
        const portFlag = extractFlag(args, '--port=');
        const port = portFlag ? Number(portFlag) : undefined;
        const r = installSessionEndHook(port !== undefined ? { port } : {});
        // biome-ignore lint/suspicious/noConsole: CLI output
        console.log(`${r.replaced ? 'Updated' : 'Installed'} SessionEnd hook in ${r.path}`);
        exit(0);
      }
      if (sub === 'uninstall') {
        const { uninstallSessionEndHook } = await import('../../lib/claude-hooks/install.ts');
        const r = uninstallSessionEndHook();
        // biome-ignore lint/suspicious/noConsole: CLI output
        console.log(r.replaced ? `Removed SessionEnd hook from ${r.path}` : 'No Robin hook found');
        exit(0);
      }
      // biome-ignore lint/suspicious/noConsole: CLI output
      console.error(`Unknown hooks subcommand: ${sub}`);
      exit(2);
      break;
    }

    case 'mcp': {
      const sub = args[1];
      if (sub === 'core') {
        const { runMcpCore } = await import('../mcp/core/run.ts');
        await runMcpCore();
        return;
      }
      if (sub === 'extension') {
        const { runMcpExtension } = await import('../mcp/extension/run.ts');
        await runMcpExtension();
        return;
      }
      if (sub === 'install') {
        try {
          // Install both surfaces so Claude sees mcp__robin__* (memory ops) and
          // mcp__robin-extension__* (integration ops + user-extension actions).
          // Without the extension entry, jobs like daily-brief can't reach gmail,
          // calendar, linear, chrome, or finance integration data.
          const coreResult = upsertUserScopeMcp(buildRobinMcpEntry({ surface: 'core' }), {
            name: 'robin',
          });
          const extResult = upsertUserScopeMcp(buildRobinMcpEntry({ surface: 'extension' }), {
            name: 'robin-extension',
          });
          // biome-ignore lint/suspicious/noConsole: CLI output
          console.log(
            `${coreResult.replaced ? 'Replaced' : 'Added'} robin MCP entry; ${extResult.replaced ? 'replaced' : 'added'} robin-extension entry in ${coreResult.path}`,
          );
          exit(0);
        } catch (err) {
          // biome-ignore lint/suspicious/noConsole: CLI output
          console.error(err instanceof Error ? err.message : String(err));
          exit(1);
        }
      }
      // biome-ignore lint/suspicious/noConsole: CLI output
      console.error(`Unknown mcp subcommand: ${sub}`);
      exit(2);
      break;
    }

    default: {
      // biome-ignore lint/suspicious/noConsole: CLI output
      console.error(`Unknown command: ${cmd}`);
      printHelp();
      exit(2);
      break;
    }
  }
}

await main();
