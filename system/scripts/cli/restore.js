import { execSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';

// Wipes everything inside user-data/ except `backup/` (where the archives
// we're restoring from live). Without this guard, restore would delete its
// own source archive mid-operation.
function wipeUserDataExceptBackup(workspaceDir) {
  const ud = join(workspaceDir, 'user-data');
  if (!existsSync(ud)) return;
  for (const entry of readdirSync(ud)) {
    if (entry === 'backup') continue;
    rmSync(join(ud, entry), { recursive: true, force: true });
  }
}

export async function restore(workspaceDir = process.cwd(), opts = {}) {
  const backupDir = join(workspaceDir, 'user-data/backup');
  if (!existsSync(backupDir)) {
    console.error('No user-data/backup/ directory.');
    process.exit(1);
  }
  const archives = readdirSync(backupDir)
    .filter(f => f.startsWith('user-data-') && f.endsWith('.tar.gz'))
    .sort().reverse();
  if (archives.length === 0) {
    console.error('No user-data backups found.');
    process.exit(1);
  }

  let chosen;
  if (opts.auto) {
    chosen = archives[0];
  } else {
    archives.forEach((a, i) => console.log(`  [${i}] ${a}`));
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ans = await rl.question('Restore which? (default 0): ');
    rl.close();
    chosen = archives[Number(ans.trim() || 0)];
  }

  if (!opts.auto) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const confirm = await rl.question('This will wipe user-data/ (except user-data/backup/). Continue? [y/N] ');
    rl.close();
    if (confirm.trim().toLowerCase() !== 'y') {
      console.log('Aborted.');
      return;
    }
  }

  wipeUserDataExceptBackup(workspaceDir);
  execSync(`tar -xzf ${JSON.stringify(join(backupDir, chosen))} -C ${JSON.stringify(workspaceDir)}`, { stdio: 'inherit' });
  console.log(`Restored from ${chosen}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await restore();
}
