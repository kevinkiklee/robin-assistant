// `robin web` — start the local web admin UI.
//
// Usage:
//   robin web                          # UNIX socket at <home>/runtime/web.sock
//   robin web --port 18791             # TCP on 127.0.0.1:18791 (CSRF enforced)
//   robin web --port 18791 --host ::1
//   robin web --no-writes              # read-only mode (refuses POST /api/query)

import { join } from 'node:path';
import { paths } from '../../../config/data-store.js';
import { close, connect } from '../../../data/db/client.js';
import { startWebServer } from '../../web/server.js';

function parseArgs(argv) {
  const out = { port: null, host: '127.0.0.1', socket: null, allowWrites: true };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--host') out.host = argv[++i];
    else if (a === '--socket') out.socket = argv[++i];
    else if (a === '--no-writes') out.allowWrites = false;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  if (out.port == null && !out.socket) {
    out.socket = join(paths.data.home(), 'runtime', 'web.sock');
  }
  return out;
}

export async function web(argv = []) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(`Usage: robin web [--port N] [--host H] [--socket PATH] [--no-writes]

Defaults to UNIX socket at <home>/runtime/web.sock. Pass --port to bind TCP
(loopback only) with CSRF enforcement. --no-writes disables POST /api/query.`);
    return;
  }
  const db = await connect();
  try {
    const r = await startWebServer({
      db,
      socketPath: args.socket,
      port: args.port,
      host: args.host,
      allowWrites: args.allowWrites,
    });
    if (r.socketPath) {
      console.log(`robin web: socket ${r.socketPath}`);
      console.log(`(connect via: curl --unix-socket ${r.socketPath} http://x/api/info)`);
    } else {
      const url = `http://${args.host.includes(':') ? `[${args.host}]` : args.host}:${r.port}`;
      console.log(`robin web: ${url}  (CSRF enforced)`);
    }
    console.log('Press Ctrl-C to stop.');
    await new Promise((_, _reject) => {
      process.on('SIGINT', async () => {
        await close(db).catch(() => {});
        process.exit(0);
      });
      process.on('SIGTERM', async () => {
        await close(db).catch(() => {});
        process.exit(0);
      });
    });
  } catch (e) {
    console.error(`robin web failed: ${e.message}`);
    await close(db).catch(() => {});
    process.exit(1);
  }
}
