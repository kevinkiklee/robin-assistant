// src/cli/commands/predictions-resolve.js
import { daemonRequest as defaultRequest } from '../daemon-request.js';

export async function predictionsResolve(argv = [], deps = {}) {
  const out = deps.out ?? ((s) => console.log(s));
  const err = deps.err ?? ((s) => console.error(s));
  const request = deps.daemonRequest ?? defaultRequest;
  const id = argv[0];
  const verdict = argv[1];
  const actual = argv.slice(2).join(' ').trim();
  if (!id || !['correct', 'incorrect'].includes(verdict)) {
    err('usage: robin predictions resolve <id> <correct|incorrect> [<actual>]');
    process.exitCode = 1;
    return;
  }
  const r = await request('/internal/predictions/resolve', {
    id,
    correct: verdict === 'correct',
    actual_outcome: actual || undefined,
  });
  if (r?.ok) {
    out(`resolved ${id} as ${verdict}`);
  } else {
    err(`resolve failed: ${r?.reason ?? 'unknown'}`);
    process.exitCode = 1;
  }
}
