#!/usr/bin/env node
import { argv, exit } from 'node:process';
import { Daemon } from '../../kernel/runtime/daemon.ts';
import { printDoctorHuman, runDoctor } from './doctor.ts';
import { runPause, runResume, runIncognito, runOffline, runOnline, runStatus } from './power.ts';
import { upsertUserScopeMcp, buildRobinMcpEntry } from '../../lib/mcp-config/write.ts';

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
  daemon      Run the Robin daemon (called by launchd; not for habitual use)
  doctor      Diagnose daemon + environment
  init        One-time setup (interactive)
  migrate     One-shot operations (from-v2)
  pause       Pause scheduled work
  resume      Resume scheduled work
  incognito   Disable session capture (--for 1h optional)
  offline     Block outbound network
  online      Restore outbound network
  status      Show current state
  mcp core    Run the robin-core MCP server (called by Claude Code via stdio)
  mcp install Add/replace robin in ~/.claude.json
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

    case 'resume': {
      runResume();
      exit(0);
      break;
    }

    case 'incognito': {
      const dur = extractFlag(args, '--for=') ?? (args[1] && !args[1].startsWith('-') ? args[1] : undefined);
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

    case 'mcp': {
      const sub = args[1];
      if (sub === 'core') {
        const { runMcpCore } = await import('../mcp/core/run.ts');
        await runMcpCore();
        return;
      }
      if (sub === 'install') {
        const r = upsertUserScopeMcp(buildRobinMcpEntry({ command: process.argv[1] }));
        // biome-ignore lint/suspicious/noConsole: CLI output
        console.log(`${r.replaced ? 'Replaced' : 'Added'} robin MCP entry in ${r.path}`);
        exit(0);
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
