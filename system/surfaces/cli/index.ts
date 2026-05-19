#!/usr/bin/env node
import { argv, exit } from 'node:process';
import { Daemon } from '../../kernel/runtime/daemon.ts';
import { printDoctorHuman, runDoctor } from './doctor.ts';

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
      runInit({
        yes: args.includes('--yes') || args.includes('-y'),
        profile: extractFlag(args, '--profile='),
        noModels: args.includes('--no-models'),
        noLaunchd: args.includes('--no-launchd'),
      });
      exit(0);
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
