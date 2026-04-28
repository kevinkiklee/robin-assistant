import { existsSync, renameSync } from 'node:fs';
import path from 'node:path';

/**
 * Rename legacy arc.config.json to robin.config.json in a workspace.
 * Returns { migrated: boolean }.
 */
export function migrateConfigFilename(workspaceDir) {
  const oldPath = path.join(workspaceDir, 'arc.config.json');
  const newPath = path.join(workspaceDir, 'robin.config.json');

  const oldExists = existsSync(oldPath);
  const newExists = existsSync(newPath);

  if (oldExists && newExists) {
    throw new Error(
      `Migration ambiguous: both arc.config.json and robin.config.json exist in ${workspaceDir}. ` +
      `Resolve manually before running again.`
    );
  }

  if (!oldExists) {
    return { migrated: false };
  }

  renameSync(oldPath, newPath);
  return { migrated: true };
}
