// `robin db browse` — opens the in-daemon DB browser in the user's default
// browser. Reads the running daemon's port from daemon-state.json.
//
// Env:
//   ROBIN_DB_NO_OPEN=1  — print the URL but skip auto-opening the browser

import { spawn } from 'node:child_process';
import { readDaemonState } from '../../daemon/state.js';
import { paths } from '../../runtime/data-store.js';

export async function dbBrowse(_argv = []) {
  const state = await readDaemonState(paths.data.daemonState());
  if (!state || typeof state.port !== 'number') {
    console.error('robin db browse: daemon is not running.');
    console.error('Start it first with: robin mcp start');
    process.exit(1);
  }
  const url = `http://127.0.0.1:${state.port}/db/`;
  console.log(`Robin DB browser: ${url}`);
  if (process.env.ROBIN_DB_NO_OPEN !== '1') openInBrowser(url);
}

function openInBrowser(url) {
  const platform = process.platform;
  const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '""', url] : [url];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
  } catch {
    /* best-effort */
  }
}
