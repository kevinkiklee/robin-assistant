import { existsSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

const STALE_PATH = 'system/scripts/pre-commit-hook.js';
const NEW_PATH = 'system/scripts/hooks/pre-commit.js';

const NEW_HOOK_CONTENT = `#!/usr/bin/env bash
exec node "$(git rev-parse --show-toplevel)/${NEW_PATH}"
`;

export async function installHooks(workspaceDir = process.cwd()) {
  const hookDir = join(workspaceDir, '.git/hooks');
  if (!existsSync(hookDir)) {
    console.warn('No .git/hooks/ directory; skipping (not a git repo?).');
    return;
  }
  const hookPath = join(hookDir, 'pre-commit');

  if (existsSync(hookPath)) {
    const existing = readFileSync(hookPath, 'utf8');
    if (existing.includes(STALE_PATH)) {
      const rewritten = existing.split(STALE_PATH).join(NEW_PATH);
      writeFileSync(hookPath, rewritten);
      console.log(`Rewrote stale path in .git/hooks/pre-commit (${STALE_PATH} → ${NEW_PATH})`);
      return;
    }
    if (existing.includes(NEW_PATH)) {
      // Already up to date — idempotent no-op.
      return;
    }
    console.log('Existing pre-commit hook found; not overwriting.');
    console.log("To integrate Robin's privacy guard, append:");
    console.log(`  node ${NEW_PATH} || exit 1`);
    return;
  }

  writeFileSync(hookPath, NEW_HOOK_CONTENT);
  chmodSync(hookPath, 0o755);
  console.log('Installed .git/hooks/pre-commit');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await installHooks();
}
