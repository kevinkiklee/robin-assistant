// `robin hooks disable <phase>` — write the phase name into
// <robinHome>/hooks-disabled.txt so the dispatcher skips it. Used as the
// kill-switch when a hook produces false-positives (spec §11).

import { DISPATCH } from '../../hooks/cli.js';
import { addDisabled } from '../../hooks/disabled.js';
import { ensureHome } from '../../runtime/data-store.js';
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
  addDisabled(phase);
  out(`disabled hook: ${phase}`);
}
