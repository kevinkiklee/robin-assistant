// `robin hooks disable <phase>` — add the phase to the disabled list in
// <robinHome>/config.json.hooks.disabled so the dispatcher skips it.
// Per-phase: disabling one phase leaves the others running. Used as the
// kill-switch when a hook produces false-positives (spec §11).

import { ensureHome } from '../../../config/data-store.js';
import { addDisabled } from '../../../config/hooks-disabled.js';
import { DISPATCH } from '../../../io/hooks/dispatcher.js';
import { parseArgs } from '../args.js';

export async function hooksDisable(argv = [], deps = {}) {
  const out = deps.out ?? ((s) => console.log(s));
  const err = deps.err ?? ((s) => console.error(s));
  const exit = deps.exit ?? ((c) => process.exit(c));

  const args = parseArgs(argv);
  const phase = args._[0];
  if (!phase || typeof phase !== 'string') {
    err('usage: robin hooks disable <phase>');
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
  await addDisabled(phase);
  out(`disabled hook: ${phase}`);
}
