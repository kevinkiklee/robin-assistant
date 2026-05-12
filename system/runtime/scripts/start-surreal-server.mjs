#!/usr/bin/env node
// start-surreal-server.mjs — launch a standalone SurrealDB server in the
// foreground. MANUAL ESCAPE HATCH ONLY.
//
// The canonical path is `robin install`, which installs + supervises the
// server via launchd (macOS) or systemd (Linux) and writes db.url into
// <robinHome>/config.json. Use this script when you want to spin the server
// up by hand for debugging — e.g., to tail logs in your terminal, try a
// different storage backend, or run on a non-default port without
// reinstalling.
//
// Usage:
//   node scripts/start-surreal-server.mjs            # uses ROBIN_HOME/db
//   node scripts/start-surreal-server.mjs --bind 127.0.0.1:8000
//   node scripts/start-surreal-server.mjs --storage rocksdb
//
// After it's running:
//   1. Update <robinHome>/config.json: { "db": { "url": "ws://127.0.0.1:8000" } }
//   2. Restart the robin daemon — it'll connect to the server.
//
// Note: surreal 3.0.4 dropped the `surrealkv+versioned://` URL scheme. Use
// `surrealkv` (default) or `rocksdb`. The `--storage` flag accepts any
// scheme the bundled surreal binary recognises.
//
// Setup (one-time):
//   brew install surrealdb/tap/surreal
//   # or:
//   curl -sSf https://install.surrealdb.com | sh

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { paths } from '../../config/data-store.js';

function parseArgs(argv) {
  const args = {
    bind: '127.0.0.1:8000',
    storage: 'surrealkv',
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
  --storage <scheme>    storage backend: surrealkv | rocksdb (default surrealkv)
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

  // Three-slash URL form (scheme:///absolute-path) is what surreal 3.0.4
  // accepts. The single-slash form `scheme:/path` is rejected with
  // "Provide a valid database path parameter".
  const url = `${args.storage}://${dbDir}`;
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
