// src/cli/daemon-request.js

import { readDaemonState } from '../../config/daemon-state.js';
import { paths } from '../../config/data-store.js';

export async function daemonRequest(path, body) {
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
  });
  return res.json();
}
