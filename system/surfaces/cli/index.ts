#!/usr/bin/env node
import { argv, exit } from 'node:process';
import { Daemon } from '../../kernel/runtime/daemon.ts';
import { buildRobinMcpEntry, upsertUserScopeMcp } from '../../lib/mcp-config/write.ts';
import { VERSION } from '../../lib/version.ts';
import { printDoctorHuman, runDoctor } from './doctor.ts';
import { runIncognito, runOffline, runOnline, runPause, runResume, runStatus } from './power.ts';

function extractFlag(args: string[], prefix: string): string | undefined {
  const found = args.find((a) => a.startsWith(prefix));
  return found?.slice(prefix.length);
}

function printHelp(all = false): void {
  // Robin runs as a daemon and is driven through Claude (the MCP tools). The CLI
  // is deliberately tiny: setup, re-auth, and a health check are the only things a
  // user normally runs. Everything else is automatic, conversational (MCP), or
  // host-invoked — shown only under `robin help --all`.
  const primary = `robin ${VERSION}

USAGE
  robin <command> [options]

Robin runs in the background and is driven through Claude (the MCP tools).
You rarely need the CLI — typically just these:

COMMANDS
  init              One-time setup: daemon, MCP servers, capture hooks, schema
  reauth <name>     Re-authorize an integration's OAuth (gmail | google_calendar)
  doctor            Health check: daemon, environment, integrations, runtime state

Run \`robin help --all\` for advanced + maintenance commands.`;

  const advanced = `
ADVANCED
  agent "<goal>"        Run a guarded agentic task (--handler=A..L | --write, --cwd=, --max-turns=, --budget=, --force)
  beliefs review        Manage the belief-candidate queue (promote <id> | reject <id> | backfill-provenance)
  publish / published   Publish a markdown file to the web / list published pages
  import <dir>          Import NDJSON dumps from content/imported-from-<source>/
  biographer            Run a bounded entity/relation extraction pass (--limit=N, --dry-run)
  reindex --force       Rebuild the vector index (repair; normal backfill is automatic)
  ingest-docs           Index content/* now (also runs automatically every 10 min)
  ingest-archive <dir>  Ingest text files from a directory into Robin memory
  db backup|restore|vacuum   Database maintenance
  pause | resume        Pause / resume scheduled work
  offline | online      Block / restore outbound network
  incognito [--for=1h]  Disable session capture

MAINTENANCE / INTERNAL (run automatically or by the host — init handles setup)
  daemon [install|uninstall]   The daemon (launchd-managed)
  mcp core | extension         MCP servers (Claude Code spawns these over stdio)
  mcp install                  Register MCP servers in ~/.claude.json
  hooks install | uninstall    Claude Code capture hooks
  primer                       Print the session-start primer (used by the hook)`;

  console.log(all ? `${primary}\n${advanced}\n` : `${primary}\n`);
}

async function main(): Promise<void> {
  const args = argv.slice(2);
  const cmd = args[0];

  switch (cmd) {
    case undefined:
    case '--help':
    case '-h':
    case 'help': {
      printHelp(args.includes('--all') || args.includes('-a'));
      exit(0);
      break;
    }

    case '--version':
    case '-v': {
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
          console.error(`usage: robin beliefs ${sub} <id> [--reason=...]`);
          exit(2);
        }
        try {
          if (sub === 'promote') runBeliefsPromote(id, opts);
          else runBeliefsReject(id, opts);
          exit(0);
        } catch (err) {
          console.error(err instanceof Error ? err.message : String(err));
          exit(1);
        }
      }
      if (sub === 'backfill-provenance') {
        const { backfillProvenance } = await import('../../brain/memory/backfill-provenance.ts');
        const { openDb } = await import('../../brain/memory/db.ts');
        const { allMigrations, applyMigrations } = await import(
          '../../brain/memory/migrations/index.ts'
        );
        const { dbFilePath, resolveUserDataDir } = await import('../../lib/paths.ts');
        const userData = resolveUserDataDir();
        const db = openDb(dbFilePath(userData));
        applyMigrations(db, allMigrations);
        const result = backfillProvenance(db);
        db.close();
        console.log(JSON.stringify(result));
        exit(0);
      }
      console.error(`Unknown beliefs subcommand: ${sub}`);
      exit(2);
      break;
    }

    case 'doctor': {
      if (args.includes('--emit-runbook')) {
        const { emitRunbook } = await import('./doctor.ts');
        const r = emitRunbook({ write: args.includes('--write') });
        console.log(`Runbook ${r.existed ? 'updated' : 'created'} at ${r.path}`);
        exit(0);
      }
      const json = args.includes('--json');
      const report = await runDoctor({ version: VERSION });
      if (json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        printDoctorHuman(report);
        // Consolidated view: doctor also shows per-integration health and the
        // current runtime state (formerly the separate `integrations`/`status`
        // commands), so one command answers "is everything OK?".
        const { runIntegrationsReport, printIntegrationsHuman } = await import('./integrations.ts');
        console.log('');
        printIntegrationsHuman(runIntegrationsReport());
        console.log('');
        runStatus(false);
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
          console.log(`${r.alreadyLoaded ? 'Reloaded' : 'Loaded'} launchd agent at ${r.plistPath}`);
          console.log(`  Daemon: ${spec.nodePath} ${spec.cliPath} daemon --foreground`);
          console.log(`  Data:   ${spec.userDataDir}`);
          exit(0);
        } catch (err) {
          console.error(err instanceof Error ? err.message : String(err));
          exit(1);
        }
      }
      if (sub === 'uninstall') {
        const { uninstallDaemonLaunchd } = await import('../../lib/launchd/install.ts');
        try {
          const r = uninstallDaemonLaunchd();
          console.log(
            r.removed
              ? `Removed launchd agent at ${r.plistPath}`
              : `No launchd agent at ${r.plistPath}`,
          );
          exit(0);
        } catch (err) {
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

    case 'biographer': {
      const { runBiographerCli, printBiographerHuman } = await import('./biographer.ts');
      const limitFlag = extractFlag(args, '--limit=');
      const report = await runBiographerCli({
        limit: limitFlag ? Number(limitFlag) : undefined,
        dryRun: args.includes('--dry-run'),
      });
      if (args.includes('--json')) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        printBiographerHuman(report);
      }
      exit(report.errors.length > 0 ? 1 : 0);
      break;
    }

    case 'ingest-docs': {
      const { runIngestDocs, printIngestDocsHuman } = await import('./ingest-docs.ts');
      const r = runIngestDocs();
      if (args.includes('--json')) {
        console.log(JSON.stringify(r, null, 2));
      } else {
        printIngestDocsHuman(r);
      }
      exit(0);
      break;
    }

    case 'ingest-archive': {
      const dir = args.find((a) => !a.startsWith('--'));
      if (!dir) {
        console.error('Usage: robin ingest-archive <dir> [--source=name] [--json]');
        exit(2);
        break;
      }
      const srcFlag = args.find((a) => a.startsWith('--source='));
      const source = srcFlag ? srcFlag.slice('--source='.length) : undefined;
      const { runIngestArchive, printIngestArchiveHuman } = await import('./ingest-archive.ts');
      const r = runIngestArchive(dir, source);
      if (args.includes('--json')) {
        console.log(JSON.stringify(r, null, 2));
      } else {
        printIngestArchiveHuman(r);
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
        console.log(`${r.replaced ? 'Updated' : 'Installed'} SessionEnd hook in ${r.path}`);
        exit(0);
      }
      if (sub === 'uninstall') {
        const { uninstallSessionEndHook } = await import('../../lib/claude-hooks/install.ts');
        const r = uninstallSessionEndHook();
        console.log(r.replaced ? `Removed SessionEnd hook from ${r.path}` : 'No Robin hook found');
        exit(0);
      }
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
          console.log(
            `${coreResult.replaced ? 'Replaced' : 'Added'} robin MCP entry; ${extResult.replaced ? 'replaced' : 'added'} robin-extension entry in ${coreResult.path}`,
          );
          exit(0);
        } catch (err) {
          console.error(err instanceof Error ? err.message : String(err));
          exit(1);
        }
      }
      console.error(`Unknown mcp subcommand: ${sub}`);
      exit(2);
      break;
    }

    default: {
      console.error(`Unknown command: ${cmd}`);
      printHelp();
      exit(2);
      break;
    }
  }
}

await main();
