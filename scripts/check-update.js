import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import { execSync } from 'child_process';

export async function checkUpdate(pkgRoot) {
  const configPath = findConfig();
  if (!configPath) {
    process.exit(0);
  }

  const workspaceDir = join(configPath, '..');
  const stateDir = join(workspaceDir, '.state');
  mkdirSync(stateDir, { recursive: true });

  const cachePath = join(stateDir, 'last-update-check');
  if (existsSync(cachePath)) {
    const lastCheck = parseInt(readFileSync(cachePath, 'utf-8').trim(), 10);
    const hoursSince = (Date.now() - lastCheck) / (1000 * 60 * 60);
    if (hoursSince < 24) {
      process.exit(0);
    }
  }

  try {
    const result = execSync('npm view arc-assistant version', {
      encoding: 'utf-8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();

    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    const current = config.version;

    if (result !== current) {
      console.log(`Update available: ${current} → ${result}`);
    }
  } catch {
    // Offline or error — exit silently
  }

  writeFileSync(cachePath, Date.now().toString());
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
