import { existsSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

export async function installHooks(workspaceDir = process.cwd()) {
  const hookDir = join(workspaceDir, '.git/hooks');
  if (!existsSync(hookDir)) {
    console.warn('No .git/hooks/ directory; skipping (not a git repo?).');
    return;
  }
  const hookPath = join(hookDir, 'pre-commit');
  if (existsSync(hookPath)) {
    console.log('Existing pre-commit hook found; not overwriting.');
    console.log("To integrate Robin's privacy guard, append:");
    console.log('  node core/scripts/pre-commit-hook.js || exit 1');
    return;
  }
  const content = `#!/usr/bin/env bash
exec node "$(git rev-parse --show-toplevel)/core/scripts/pre-commit-hook.js"
`;
  writeFileSync(hookPath, content);
  chmodSync(hookPath, 0o755);
  console.log('Installed .git/hooks/pre-commit');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await installHooks();
}
