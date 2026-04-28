import { execSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';

export async function restore(workspaceDir = process.cwd(), opts = {}) {
  const backupDir = join(workspaceDir, 'backup');
  if (!existsSync(backupDir)) {
    console.error('No backup/ directory.');
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
    const confirm = await rl.question('This will wipe user-data/. Continue? [y/N] ');
    rl.close();
    if (confirm.trim().toLowerCase() !== 'y') {
      console.log('Aborted.');
      return;
    }
  }

  rmSync(join(workspaceDir, 'user-data'), { recursive: true, force: true });
  execSync(`tar -xzf ${JSON.stringify(join(backupDir, chosen))} -C ${JSON.stringify(workspaceDir)}`, { stdio: 'inherit' });
  console.log(`Restored from ${chosen}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await restore();
}
