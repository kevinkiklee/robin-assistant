// `robin pre-commit run` — invoked by `.git/hooks/pre-commit`. Scans the
// staged diff for credential/secret patterns and refuses the commit on hit.
//
// Users do not run this directly.

import { runPreCommit } from '../../install/pre-commit.js';

export async function preCommitRun(_argv = []) {
  await runPreCommit();
}
