// src/cli/daemon-request.js

import { readDaemonState } from '../../config/daemon-state.js';
import { paths } from '../../config/data-store.js';

// 60s default covers slow endpoints (ingest, audit, full re-embed). Set
// $ROBIN_DAEMON_REQUEST_TIMEOUT_MS to override for diagnostics. Without a
// timeout a stuck or runaway daemon hangs every CLI command indefinitely.
const DEFAULT_TIMEOUT_MS = 60_000;

function resolveTimeoutMs(explicit) {
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const env = Number.parseInt(process.env.ROBIN_DAEMON_REQUEST_TIMEOUT_MS ?? '', 10);
  if (Number.isInteger(env) && env > 0) return env;
  return DEFAULT_TIMEOUT_MS;
}

export async function daemonRequest(path, body, { timeoutMs } = {}) {
  const state = await readDaemonState(paths.data.daemonState());
  if (!state?.port) throw new Error('daemon not running');
  const headers = { 'content-type': 'application/json' };
  // Daemons that wrote state pre-auth-rollout omit `auth_token`. We send no
  // Authorization header in that case; the daemon also omits the auth check
  // when its `authToken` is falsy, so old daemons keep working. After the
  // user runs `robin mcp restart`, the token is generated and gates kick in.
  if (state.auth_token) headers.authorization = `Bearer ${state.auth_token}`;
  const res = await fetch(`http://127.0.0.1:${state.port}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(resolveTimeoutMs(timeoutMs)),
  });
  // Daemon errors land here with `{ok:false, ...}` JSON; surface the parse
  // failure with a useful message instead of an opaque SyntaxError.
  try {
    return await res.json();
  } catch (e) {
    throw new Error(`daemon returned non-JSON response (${res.status}): ${e.message}`);
  }
}
