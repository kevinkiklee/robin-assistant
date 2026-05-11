// src/cli/commands/commstyle-refresh.js
import { daemonRequest as defaultRequest } from '../daemon-request.js';

export async function commstyleRefresh(_argv = [], deps = {}) {
  const out = deps.out ?? ((s) => console.log(s));
  const err = deps.err ?? ((s) => console.error(s));
  const request = deps.daemonRequest ?? defaultRequest;
  const r = await request('/internal/comm-style/refresh');
  if (r?.ok) {
    out(`ok — signals_used=${r.signals_used ?? 0}, confidence=${r.comm_style?.confidence ?? '?'}`);
  } else {
    err(`refresh failed: ${r?.reason ?? 'unknown'}`);
    process.exitCode = 1;
  }
}
