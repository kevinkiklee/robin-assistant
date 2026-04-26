import { readFileSync, writeFileSync, existsSync, rmSync, cpSync } from 'fs';
import { join } from 'path';
import { createInterface } from 'readline';
import { findConfig } from './lib/find-config.js';
import { USER_DATA_FILES } from './lib/platforms.js';

export async function reset(pkgRoot) {
  const configPath = findConfig();
  if (!configPath) {
    console.error('Error: arc.config.json not found. Are you in a Robin workspace?');
    process.exit(1);
  }

  const workspaceDir = join(configPath, '..');

  const confirmed = await confirm(
    `This will DELETE user data (${USER_DATA_FILES.join(', ')}) and clear state/. System files, protocols, and config are preserved. Continue?`
  );
  if (!confirmed) { console.log('Cancelled.'); return; }

  const templatesDir = join(pkgRoot, 'templates');

  for (const file of USER_DATA_FILES) {
    const dest = join(workspaceDir, file);
    const src = join(templatesDir, file);
    if (existsSync(src)) {
      cpSync(src, dest);
    }
  }

  const stateDir = join(workspaceDir, 'state');
  for (const file of ['sessions.md', 'dream-state.md']) {
    const src = join(templatesDir, 'state', file);
    if (existsSync(src)) {
      cpSync(src, join(stateDir, file));
    }
  }

  const locksDir = join(stateDir, 'locks');
  if (existsSync(locksDir)) {
    const { readdirSync } = await import('fs');
    for (const f of readdirSync(locksDir)) {
      if (f.endsWith('.lock')) rmSync(join(locksDir, f));
    }
  }

  console.log('Reset complete. User data wiped to fresh templates.');
}

function confirm(message) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(`${message} (y/N) `, answer => {
      rl.close();
      resolve(answer.toLowerCase() === 'y');
    });
  });
}
