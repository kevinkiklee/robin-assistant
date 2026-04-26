import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { findConfig } from './lib/find-config.js';

export async function checkUpdate(pkgRoot) {
  const configPath = findConfig();
  if (!configPath) { process.exit(0); }

  const workspaceDir = join(configPath, '..');
  const stateDir = join(workspaceDir, 'state');
  mkdirSync(stateDir, { recursive: true });

  const cachePath = join(stateDir, 'last-update-check');
  if (existsSync(cachePath)) {
    const lastCheck = parseInt(readFileSync(cachePath, 'utf-8').trim(), 10);
    const hoursSince = (Date.now() - lastCheck) / (1000 * 60 * 60);
    if (hoursSince < 24) { process.exit(0); }
  }

  try {
    const result = execSync('npm view arc-assistant version', {
      encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe']
    }).trim();

    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    if (result !== config.version) {
      console.log(`Update available: ${config.version} -> ${result}`);
    }
  } catch { /* offline */ }

  writeFileSync(cachePath, Date.now().toString());
}
