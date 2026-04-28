import { execSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export async function backup(workspaceDir = process.cwd()) {
  const ud = join(workspaceDir, 'user-data');
  if (!existsSync(ud)) {
    console.error('No user-data/ to back up.');
    process.exit(1);
  }
  const backupDir = join(workspaceDir, 'backup');
  if (!existsSync(backupDir)) mkdirSync(backupDir, { recursive: true });

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const archive = join(backupDir, `user-data-${ts}.tar.gz`);
  execSync(`tar -czf ${JSON.stringify(archive)} -C ${JSON.stringify(workspaceDir)} user-data`, { stdio: 'inherit' });
  console.log(`Backed up to ${archive}`);
  return archive;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await backup();
}
