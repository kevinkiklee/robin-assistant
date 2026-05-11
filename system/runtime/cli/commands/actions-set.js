// src/cli/commands/actions-set.js
import { daemonRequest as defaultRequest } from '../daemon-request.js';

export async function actionsSet(argv = [], deps = {}) {
  const out = deps.out ?? ((s) => console.log(s));
  const err = deps.err ?? ((s) => console.error(s));
  const request = deps.daemonRequest ?? defaultRequest;
  const cls = argv[0];
  const state = (argv[1] ?? '').toUpperCase();
  if (!cls || !['AUTO', 'ASK', 'NEVER'].includes(state)) {
    err('usage: robin actions set <class> <auto|ask|never>');
    process.exitCode = 1;
    return;
  }
  const r = await request('/internal/actions/set', { class: cls, state });
  if (r?.ok) {
    out(`${cls} → ${state}`);
  } else {
    err(`set failed: ${r?.reason ?? 'unknown'}`);
    process.exitCode = 1;
  }
}
