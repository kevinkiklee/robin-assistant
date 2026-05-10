// `robin pre-commit uninstall` — remove our pre-commit hook if (and only if)
// the file points at our run script. Leaves unrelated hooks alone.

import { uninstallPreCommit } from '../../install/pre-commit.js';

export async function preCommitUninstall(_argv = []) {
  const result = await uninstallPreCommit({ cwd: process.cwd() });
  if (result.uninstalled) {
    console.log(`pre-commit hook removed (${result.path ?? '.git/hooks/pre-commit'})`);
    return;
  }
  console.log(`pre-commit uninstall: ${result.reason ?? 'nothing to do'}`);
}
