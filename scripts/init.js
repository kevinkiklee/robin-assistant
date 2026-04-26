import { existsSync, readdirSync, mkdirSync, cpSync, writeFileSync, chmodSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { execSync } from 'child_process';
import { generateClaudeMd } from './generate-claude-md.js';

export async function init(directory, options, pkgRoot) {
  const targetDir = resolve(directory);

  // Guard: non-empty directory
  if (existsSync(targetDir) && readdirSync(targetDir).length > 0 && !options.force) {
    console.error(`Error: ${targetDir} is not empty. Use --force to override.`);
    process.exit(1);
  }

  mkdirSync(targetDir, { recursive: true });

  console.log('Scaffolding Arc workspace...');

  // Copy user-data/ as the workspace scaffold
  const userDataDir = join(pkgRoot, 'user-data');
  cpSync(userDataDir, targetDir, { recursive: true });

  // Remove package-only files that shouldn't be in the workspace
  const hbsFile = join(targetDir, 'CLAUDE.md.hbs');
  if (existsSync(hbsFile)) {
    rmSync(hbsFile);
  }

  // Copy core/ into workspace
  const coreSource = join(pkgRoot, 'core');
  const coreDest = join(targetDir, 'core');
  cpSync(coreSource, coreDest, { recursive: true });

  // Make coordination scripts executable
  const coordDir = join(coreDest, 'coordination');
  for (const script of ['lock.sh', 'register-session.sh']) {
    const scriptPath = join(coordDir, script);
    if (existsSync(scriptPath)) {
      chmodSync(scriptPath, 0o755);
    }
  }

  // Create .state/ directories
  mkdirSync(join(targetDir, '.state', 'coordination', 'sessions'), { recursive: true });
  mkdirSync(join(targetDir, '.state', 'coordination', 'locks'), { recursive: true });

  // Generate CLAUDE.md from template
  generateClaudeMd(targetDir, pkgRoot);

  // Create workspace package.json
  const workspacePkg = {
    private: true,
    dependencies: {
      'arc-assistant': `^1.0.0`
    }
  };
  writeFileSync(
    join(targetDir, 'package.json'),
    JSON.stringify(workspacePkg, null, 2) + '\n'
  );

  // Generate workspace README
  writeFileSync(join(targetDir, 'README.md'), getReadmeContent());

  // git init (skip if already a repo)
  const isGitRepo = existsSync(join(targetDir, '.git'));
  if (!isGitRepo) {
    execSync('git init', { cwd: targetDir, stdio: 'pipe' });
  }

  // Install pre-push hook
  const hooksDir = join(targetDir, '.git', 'hooks');
  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(join(hooksDir, 'pre-push'), PRE_PUSH_HOOK);
  chmodSync(join(hooksDir, 'pre-push'), 0o755);

  // npm install
  console.log('Installing dependencies...');
  try {
    execSync('npm install', { cwd: targetDir, stdio: 'pipe' });
  } catch {
    console.log('Note: npm install skipped (run it manually if needed)');
  }

  // Initial commit
  if (!isGitRepo) {
    execSync('git add -A', { cwd: targetDir, stdio: 'pipe' });
    execSync('git commit -m "Initialize Arc workspace (arc-assistant v1.0.0)"', {
      cwd: targetDir, stdio: 'pipe'
    });
  }

  console.log(`\nDone. Open ${targetDir} in Claude Code — Arc will take it from here.`);
}

const PRE_PUSH_HOOK = `#!/bin/sh
# Arc safety hook — this workspace contains personal data.
# Pushing to a remote is blocked by default.
echo "ERROR: This Arc workspace contains personal data."
echo "Pushing to a remote repository is blocked for safety."
echo "If you really need to push, remove .git/hooks/pre-push"
exit 1
`;

function getReadmeContent() {
  return `# Arc Workspace

This is your personal Arc workspace — a self-improving assistant powered by Claude Code.

## Directory Structure

| Directory | Owner | Purpose |
|---|---|---|
| \`core/\` | Arc (updated automatically) | Protocols, rules, coordination scripts |
| \`profile/\` | You | Identity, personality, goals, preferences |
| \`memory/\` | You | Long-term and short-term context |
| \`todos/\` | You | Tasks by category |
| \`knowledge/\` | You | Vendors, locations, medical, references |
| \`decisions/\` | You | Decision journal with outcomes |
| \`journal/\` | You | Daily reflections |
| \`inbox/\` | You | Quick capture for unprocessed thoughts |
| \`skills/\` | You | Your domain-specific playbooks |
| \`self-improvement/\` | You | Mistakes, corrections, patterns, predictions |
| \`overrides/\` | You | Customizations that extend core/ behavior |
| \`share/\` | You | Drop zone for documents to process |
| \`artifacts/\` | You | Generated outputs |
| \`archive/\` | You | Backups of core/ before updates |

## Getting Started

Open this directory in Claude Code. Arc will introduce itself and walk you through setup.

## Privacy

This workspace contains personal information. It is **local-only by default**:
- A pre-push git hook blocks all pushes to remote repositories
- All data stays on your machine except when sent to Anthropic's API via Claude Code
- Review [Anthropic's data policy](https://www.anthropic.com/privacy) for details on API data handling

## Updates

Arc checks for updates at the start of each session (at most once per day). When an update is available, Arc will ask for your approval before applying it.

Manual update: \`npx arc-assistant update\`
`;
}
