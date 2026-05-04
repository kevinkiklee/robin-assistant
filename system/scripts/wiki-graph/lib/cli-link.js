import { applyEntityLinks } from './apply-entity-links.js';
import { buildEntityRegistry } from './build-entity-registry.js';
import { resolveCliWorkspaceDir } from '../../lib/workspace-root.js';

export async function cmdLink(argv, opts = {}) {
  // Fall through to resolveCliWorkspaceDir when no override is passed — it
  // validates ROBIN_WORKSPACE / process.cwd() against the bin/robin.js marker
  // and fails loudly if invoked from inside user-data/ (which would otherwise
  // double up workspace-rooted paths via join(workspaceDir, 'user-data/...')).
  const workspaceDir = opts.workspaceDir || resolveCliWorkspaceDir();
  const dryRun = argv.includes('--dry-run');
  const path = argv.find((a) => !a.startsWith('--'));

  if (!path) {
    process.stderr.write('usage: robin link <path> [--dry-run]\n');
    return 2;
  }

  let registry;
  try {
    registry = await buildEntityRegistry(workspaceDir);
  } catch (err) {
    process.stderr.write(`robin link: registry error — ${err.message}\n`);
    return 1;
  }

  const result = await applyEntityLinks(workspaceDir, path, registry, { dryRun });
  if (result.errors && result.errors.length) {
    for (const e of result.errors) process.stderr.write(`robin link: ${e}\n`);
  }

  const action = dryRun ? 'would insert' : 'inserted';
  process.stdout.write(`${path}: ${action} ${result.inserted} link(s)\n`);
  return 0;
}
