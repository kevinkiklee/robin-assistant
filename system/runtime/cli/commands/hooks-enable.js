// `robin hooks enable <phase>` — remove the phase from the disabled list
// in <robinHome>/config.json.hooks.disabled. Inverse of `robin hooks disable`.
// Per-phase: enabling one phase leaves the others untouched.

import { ensureHome } from '../../../config/data-store.js';
import { removeDisabled } from '../../../io/hooks/disabled.js';
import { DISPATCH } from '../../../io/hooks/dispatcher.js';
import { parseArgs } from '../args.js';

export async function hooksEnable(argv = [], deps = {}) {
  const out = deps.out ?? ((s) => console.log(s));
  const err = deps.err ?? ((s) => console.error(s));
  const exit = deps.exit ?? ((c) => process.exit(c));

  const args = parseArgs(argv);
  const phase = args._[0];
  if (!phase || typeof phase !== 'string') {
    err('usage: robin hooks enable <phase>');
    err(`valid phases: ${Object.keys(DISPATCH).join(', ')}`);
    exit(1);
    return;
  }
  if (!Object.hasOwn(DISPATCH, phase)) {
    err(`unknown hook phase: ${phase}`);
    err(`valid phases: ${Object.keys(DISPATCH).join(', ')}`);
    exit(1);
    return;
  }
  await ensureHome();
  await removeDisabled(phase);
  out(`enabled hook: ${phase}`);
}
