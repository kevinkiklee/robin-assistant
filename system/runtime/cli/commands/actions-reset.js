// src/cli/commands/actions-reset.js
import { daemonRequest as defaultRequest } from '../daemon-request.js';

export async function actionsReset(argv = [], deps = {}) {
  const out = deps.out ?? ((s) => console.log(s));
  const err = deps.err ?? ((s) => console.error(s));
  const request = deps.daemonRequest ?? defaultRequest;
  const cls = argv[0];
  if (!cls) {
    err('usage: robin actions reset <class>');
    process.exitCode = 1;
    return;
  }
  const r = await request('/internal/actions/reset', { class: cls });
  if (r?.ok) {
    out(`${cls} → ASK (default)`);
  } else {
    err(`reset failed: ${r?.reason ?? 'unknown'}`);
    process.exitCode = 1;
  }
}
