import { existsSync, readdirSync, mkdirSync, cpSync, writeFileSync, chmodSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { execSync } from 'child_process';
import { createInterface } from 'readline';
import { PLATFORMS, generateIntegrationsMd } from './lib/platforms.js';

export async function init(directory, options, pkgRoot) {
  const platform = options.platform || await askPlatform();
  const targetDir = resolve(directory);

  if (existsSync(targetDir) && readdirSync(targetDir).length > 0 && !options.force) {
    console.error(`Error: ${targetDir} is not empty. Use --force to override.`);
    process.exit(1);
  }

  await initWithOptions(targetDir, { ...options, platform }, pkgRoot);

  console.log(`\nDone. Open ${targetDir} in your AI coding tool — Robin will take it from here.`);
}

export async function initWithOptions(targetDir, options, pkgRoot) {
  const { platform, name, timezone, email } = options;

  mkdirSync(targetDir, { recursive: true });

  const templatesDir = join(pkgRoot, 'templates');
  cpSync(templatesDir, targetDir, { recursive: true });

  mkdirSync(join(targetDir, 'state', 'locks'), { recursive: true });
  mkdirSync(join(targetDir, 'artifacts'), { recursive: true });
  mkdirSync(join(targetDir, 'archive'), { recursive: true });

  const config = JSON.parse(readFileSync(join(targetDir, 'arc.config.json'), 'utf-8'));
  config.platform = platform;
  if (name) {
    config.user.name = name;
    config.initialized = true;
  }
  if (timezone) config.user.timezone = timezone;
  if (email) config.user.email = email;
  if (name && timezone) config.initialized = true;
  writeFileSync(join(targetDir, 'arc.config.json'), JSON.stringify(config, null, 2) + '\n');

  const integrationsMd = generateIntegrationsMd(platform, []);
  writeFileSync(join(targetDir, 'integrations.md'), integrationsMd);

  const platformConfig = PLATFORMS[platform];
  if (platformConfig && platformConfig.pointerFile) {
    writeFileSync(join(targetDir, platformConfig.pointerFile), platformConfig.pointerContent);
  }

  const isGitRepo = existsSync(join(targetDir, '.git'));
  if (!isGitRepo) {
    try {
      execSync('git init', { cwd: targetDir, stdio: 'pipe' });
    } catch { /* git not available */ }
  }

  const hooksDir = join(targetDir, '.git', 'hooks');
  if (existsSync(join(targetDir, '.git'))) {
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(join(hooksDir, 'pre-push'), PRE_PUSH_HOOK);
    chmodSync(join(hooksDir, 'pre-push'), 0o755);
  }
}

async function askPlatform() {
  const platforms = Object.keys(PLATFORMS);
  console.log('\nWhich AI tool are you using?');
  platforms.forEach((p, i) => console.log(`  ${i + 1}. ${p}`));

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question('\nSelect (1-6): ', answer => {
      rl.close();
      const idx = parseInt(answer, 10) - 1;
      resolve(platforms[idx] || 'claude-code');
    });
  });
}

const PRE_PUSH_HOOK = `#!/bin/sh
# Robin safety hook — this workspace may contain personal data.
echo "ERROR: This Robin workspace may contain personal data."
echo "Pushing to a remote repository is blocked for safety."
echo "If you really need to push, remove .git/hooks/pre-push"
exit 1
`;
