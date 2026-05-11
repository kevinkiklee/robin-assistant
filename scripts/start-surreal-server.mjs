#!/usr/bin/env node
// start-surreal-server.mjs — launch a standalone SurrealDB server.
//
// Workaround for @surrealdb/node 3.0.3's surrealkv+versioned embedded-engine
// hang. The standalone `surreal` binary supports the full set of v3 storage
// backends — including versioned storage — and we connect via ws://.
//
// Usage:
//   node scripts/start-surreal-server.mjs            # uses ROBIN_HOME/db
//   node scripts/start-surreal-server.mjs --bind 127.0.0.1:8000
//   node scripts/start-surreal-server.mjs --storage surrealkv+versioned
//
// After it's running:
//   1. Update <robinHome>/config.json: { "db": { "url": "ws://127.0.0.1:8000" } }
//   2. Restart the robin daemon — it'll connect to the server.
//
// Setup (one-time):
//   brew install surrealdb/tap/surreal
//   # or:
//   curl -sSf https://install.surrealdb.com | sh

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { paths } from '../src/runtime/data-store.js';

function parseArgs(argv) {
  const args = {
    bind: '127.0.0.1:8000',
    storage: 'surrealkv+versioned',
    user: 'root',
    pass: 'root',
    log: 'info',
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === '--bind' && v) {
      args.bind = v;
      i++;
    } else if (k === '--storage' && v) {
      args.storage = v;
      i++;
    } else if (k === '--user' && v) {
      args.user = v;
      i++;
    } else if (k === '--pass' && v) {
      args.pass = v;
      i++;
    } else if (k === '--log' && v) {
      args.log = v;
      i++;
    } else if (k === '--help' || k === '-h') {
      console.log(`Usage: node scripts/start-surreal-server.mjs [options]

Options:
  --bind <host:port>    bind address (default 127.0.0.1:8000)
  --storage <scheme>    storage backend: surrealkv | surrealkv+versioned | rocksdb (default surrealkv+versioned)
  --user <name>         root username (default root)
  --pass <pass>         root password (default root)
  --log <level>         log level: error|warn|info|debug|trace (default info)

After start:
  1. Update <robinHome>/config.json: { "db": { "url": "ws://<host:port>" } }
  2. Restart the robin daemon.
`);
      process.exit(0);
    }
  }
  return args;
}

async function ensureSurrealInstalled() {
  return new Promise((resolve) => {
    const p = spawn('surreal', ['version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    p.on('error', () => resolve(false));
    p.on('exit', (code) => resolve(code === 0));
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!(await ensureSurrealInstalled())) {
    console.error(`'surreal' binary not found on PATH.

Install with one of:
  brew install surrealdb/tap/surreal
  curl -sSf https://install.surrealdb.com | sh

Then re-run this script.`);
    process.exit(1);
  }

  const dbDir = paths.data.db();
  if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });

  const url = `${args.storage}:${dbDir}`;
  console.log(`Starting SurrealDB server:`);
  console.log(`  bind:    ${args.bind}`);
  console.log(`  storage: ${url}`);
  console.log(`  log:     ${args.log}`);
  console.log(`  user:    ${args.user}`);
  console.log('');
  console.log(`Next step — update <robinHome>/config.json:`);
  console.log(`  { "db": { "url": "ws://${args.bind}" } }`);
  console.log('');

  const proc = spawn(
    'surreal',
    [
      'start',
      '--bind',
      args.bind,
      '--user',
      args.user,
      '--pass',
      args.pass,
      '--log',
      args.log,
      url,
    ],
    { stdio: 'inherit' },
  );

  const onTerm = () => proc.kill('SIGTERM');
  process.once('SIGINT', onTerm);
  process.once('SIGTERM', onTerm);
  proc.on('exit', (code) => process.exit(code ?? 0));
}

main().catch((e) => {
  console.error('start-surreal-server failed:', e.message);
  process.exit(2);
});
