import { applyEntityLinks } from './apply-entity-links.js';
import { buildEntityRegistry } from './build-entity-registry.js';

export async function cmdLink(argv, opts = {}) {
  const workspaceDir = opts.workspaceDir || process.env.ROBIN_WORKSPACE || process.cwd();
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
