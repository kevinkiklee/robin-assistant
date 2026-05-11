// src/cli/daemon-request.js

import { readDaemonState } from '../../config/daemon-state.js';
import { paths } from '../../config/data-store.js';

export async function daemonRequest(path, body) {
  const state = await readDaemonState(paths.data.daemonState());
  if (!state?.port) throw new Error('daemon not running');
  const res = await fetch(`http://127.0.0.1:${state.port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return res.json();
}
