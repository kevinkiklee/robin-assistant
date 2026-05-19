#!/usr/bin/env node
import { argv, exit } from 'node:process';

const VERSION = '3.0.0-alpha.0';

function printHelp(): void {
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

const args = argv.slice(2);
const cmd = args[0];

switch (cmd) {
  case undefined:
  case '--help':
  case '-h':
  case 'help':
    printHelp();
    exit(0);
    break;
  case '--version':
  case '-v':
    console.log(VERSION);
    exit(0);
    break;
  default:
    console.error(`Unknown command: ${cmd}`);
    printHelp();
    exit(2);
}
