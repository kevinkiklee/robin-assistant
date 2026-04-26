import { readFileSync, writeFileSync, existsSync, rmSync, cpSync } from 'fs';
import { join, resolve } from 'path';
import { createInterface } from 'readline';
import { generateClaudeMd } from './generate-claude-md.js';

export async function reset(pkgRoot) {
  const configPath = findConfig();
  if (!configPath) {
    console.error('Error: arc.config.json not found. Are you in an Arc workspace?');
    process.exit(1);
  }

  const workspaceDir = join(configPath, '..');

  const confirmed = await confirm(
    'This will DELETE all user data (profile, memory, todos, knowledge, decisions, journal, inbox, skills, self-improvement, overrides, share, artifacts). core/ will be preserved. Continue?'
  );

  if (!confirmed) {
    console.log('Cancelled.');
    return;
  }

  const userDirs = [
    'profile', 'memory', 'todos', 'knowledge', 'decisions',
    'journal', 'inbox', 'skills', 'self-improvement', 'overrides',
    'share', 'artifacts', 'archive'
  ];

  for (const dir of userDirs) {
    const fullPath = join(workspaceDir, dir);
    if (existsSync(fullPath)) {
      rmSync(fullPath, { recursive: true, force: true });
    }
  }

  const userDataDir = join(pkgRoot, 'user-data');
  for (const dir of userDirs) {
    const source = join(userDataDir, dir);
    if (existsSync(source)) {
      cpSync(source, join(workspaceDir, dir), { recursive: true });
    }
  }

  const freshConfig = JSON.parse(readFileSync(join(userDataDir, 'arc.config.json'), 'utf-8'));
  const currentConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
  freshConfig.version = currentConfig.version;
  writeFileSync(configPath, JSON.stringify(freshConfig, null, 2) + '\n');

  generateClaudeMd(workspaceDir, pkgRoot);

  console.log('Reset complete. All user data wiped. Workspace is a fresh slate.');
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

function findConfig() {
  let dir = resolve('.');
  while (dir !== '/') {
    const candidate = join(dir, 'arc.config.json');
    if (existsSync(candidate)) return candidate;
    dir = join(dir, '..');
  }
  return null;
}
