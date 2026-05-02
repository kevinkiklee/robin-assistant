import { existsSync, rmSync, cpSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { backup } from './backup.js';

export async function reset(workspaceDir = process.cwd(), opts = {}) {
  if (!opts.confirmed) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const confirm = await rl.question('Wipe user-data/ back to scaffold? [y/N] ');
    rl.close();
    if (confirm.trim().toLowerCase() !== 'y') return;
  }
  if (!opts.skipBackup) await backup(workspaceDir);

  const ud = join(workspaceDir, 'user-data');
  rmSync(ud, { recursive: true, force: true });
  mkdirSync(ud, { recursive: true });

  const skel = join(workspaceDir, 'system/scaffold');
  if (existsSync(skel)) {
    for (const entry of readdirSync(skel)) {
      if (entry === 'README.md') continue;
      cpSync(join(skel, entry), join(ud, entry), { recursive: true });
    }
  }
  console.log('user-data/ reset to scaffold.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await reset();
}
