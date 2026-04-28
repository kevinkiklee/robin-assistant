import { existsSync, readdirSync } from 'fs';
import { join } from 'path';

export async function migrate(workspaceDir, pkgRoot, fromVersion, toVersion) {
  const migrationsDir = join(pkgRoot, 'scripts', 'migrations');
  if (!existsSync(migrationsDir)) return;

  const files = readdirSync(migrationsDir)
    .filter(f => f.endsWith('.js'))
    .sort();

  for (const file of files) {
    const match = file.match(/^(.+)-to-(.+)\.js$/);
    if (!match) continue;

    const [, migrationFrom, migrationTo] = match;

    if (compareVersions(migrationFrom, fromVersion) >= 0 &&
        compareVersions(migrationTo, toVersion) <= 0) {
      console.log(`Running migration: ${file}`);
      const migration = await import(join(migrationsDir, file));
      await migration.default(workspaceDir);
    }
  }
}

function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}
