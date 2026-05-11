// `robin remember [--force] <content>` — CLI memory write through the daemon.
// --force bypasses the inbound PII guard. Spec §11 escape hatch.
// Daemon-required: agents have their own MCP `remember` tool; this CLI is the
// human-driven path for cases where a refusal needs to be overridden.

import { isPidAlive } from '../../daemon/lock.js';
import { readDaemonState } from '../../daemon/state.js';
import { paths } from '../../runtime/data-store.js';
import { parseArgs } from '../args.js';

export async function remember(argv = []) {
  const args = parseArgs(argv);
  const force = args.flags.force === true;
  const content = args._.join(' ').trim();
  if (!content) {
    console.error('usage: robin remember [--force] <content>');
    process.exit(1);
  }

  const state = await readDaemonState(paths.data.daemonState());
  if (!state || !isPidAlive(state.pid)) {
    console.error('daemon not running. Start it with: robin mcp start');
    process.exit(1);
  }

  let res;
  try {
    res = await fetch(`http://127.0.0.1:${state.port}/internal/remember`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content, force, source: 'cli' }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (e) {
    console.error(`request failed: ${e.message}`);
    process.exit(1);
  }

  const json = await res.json().catch(() => ({}));
  if (res.status === 422 && json.name === 'RobinPiiRefusedError') {
    console.error(`refused: ${json.error}`);
    console.error('Re-run with --force to bypass the guard if intentional.');
    process.exit(2);
  }
  if (!res.ok) {
    console.error(`error (${res.status}): ${json.error ?? 'unknown'}`);
    process.exit(1);
  }
  console.log(`stored event ${json.id}${force ? ' (PII guard bypassed)' : ''}`);
}
