// `robin pre-commit install` — install the privacy pre-commit hook in the
// git repo at process.cwd(). See src/install/pre-commit.js for behavior.

import { installPreCommit } from '../../install/pre-commit.js';

export async function preCommitInstall(_argv = []) {
  const result = await installPreCommit({ cwd: process.cwd() });
  if (result.installed) {
    console.log(`pre-commit hook installed at ${result.path ?? '.git/hooks/pre-commit'}`);
    return;
  }
  console.error(`pre-commit install skipped: ${result.reason ?? 'unknown reason'}`);
  process.exit(1);
}
