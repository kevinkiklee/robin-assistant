import { existsSync, statSync, readdirSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { execSync } from 'child_process';

export async function validate() {
  const configPath = findConfig();
  if (!configPath) {
    console.error('Error: arc.config.json not found. Are you in an Arc workspace?');
    process.exit(1);
  }

  const workspaceDir = join(configPath, '..');
  let issues = 0;

  console.log('Validating Arc workspace...\n');

  // 1. Check arc.config.json is valid JSON
  try {
    JSON.parse(readFileSync(configPath, 'utf-8'));
    ok('arc.config.json is valid JSON');
  } catch {
    fail('arc.config.json is invalid JSON');
    issues++;
  }

  // 2. Check core/ exists and has key files
  const coreFiles = [
    'core/hard-rules.md',
    'core/session-startup.md',
    'core/passive-capture.md',
    'core/privacy-scan.md',
    'core/version.json',
    'core/protocols/INDEX.md',
    'core/protocols/dream.md',
    'core/coordination/lock.sh',
    'core/coordination/register-session.sh',
    'core/self-improvement/failure-modes.md',
    'core/self-improvement/known-patterns.md',
  ];

  for (const file of coreFiles) {
    const fullPath = join(workspaceDir, file);
    if (existsSync(fullPath)) {
      ok(`${file} exists`);
    } else {
      fail(`${file} MISSING`);
      issues++;
    }
  }

  // 3. Check CLAUDE.md exists
  if (existsSync(join(workspaceDir, 'CLAUDE.md'))) {
    ok('CLAUDE.md exists');
  } else {
    fail('CLAUDE.md MISSING — run: npx arc-assistant configure');
    issues++;
  }

  // 4. Check coordination scripts are executable
  for (const script of ['lock.sh', 'register-session.sh']) {
    const scriptPath = join(workspaceDir, 'core', 'coordination', script);
    if (existsSync(scriptPath)) {
      const stats = statSync(scriptPath);
      if (stats.mode & 0o111) {
        ok(`${script} is executable`);
      } else {
        fail(`${script} is NOT executable — run: chmod +x ${scriptPath}`);
        issues++;
      }
    }
  }

  // 5. Check .state/ directory exists
  if (existsSync(join(workspaceDir, '.state', 'coordination'))) {
    ok('.state/coordination/ exists');
  } else {
    warn('.state/coordination/ missing — will be created on first session');
  }

  // 6. Check for git remotes
  try {
    const remotes = execSync('git remote -v', { cwd: workspaceDir, encoding: 'utf-8' }).trim();
    if (remotes) {
      fail(`Git remotes found — this workspace contains personal data!\n    ${remotes.split('\n').join('\n    ')}`);
      issues++;
    } else {
      ok('No git remotes (local-only)');
    }
  } catch {
    ok('No git repository or no remotes');
  }

  // 7. Check pre-push hook exists
  const hookPath = join(workspaceDir, '.git', 'hooks', 'pre-push');
  if (existsSync(hookPath)) {
    ok('Pre-push safety hook installed');
  } else {
    warn('Pre-push safety hook missing — run arc init to reinstall');
  }

  // 8. Check for orphaned overrides
  const overridesDir = join(workspaceDir, 'overrides');
  if (existsSync(overridesDir)) {
    checkOrphanedOverrides(workspaceDir, overridesDir);
  }

  // Summary
  console.log(`\n${issues === 0 ? 'All checks passed.' : `${issues} issue(s) found.`}`);
  process.exit(issues > 0 ? 1 : 0);
}

function checkOrphanedOverrides(workspaceDir, overridesDir) {
  const walk = (dir, prefix = '') => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.gitkeep') continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(join(dir, entry.name), rel);
      } else if (entry.name.endsWith('.local.md')) {
        const coreName = entry.name.replace('.local.md', '.md');
        const coreDir = rel.replace(entry.name, coreName);
        const corePath = join(workspaceDir, 'core', coreDir);
        if (!existsSync(corePath)) {
          warn(`Orphaned override: overrides/${rel} (no matching core file)`);
        }
      }
    }
  };
  walk(overridesDir);
}

function ok(msg) { console.log(`  ✓ ${msg}`); }
function fail(msg) { console.log(`  ✗ ${msg}`); }
function warn(msg) { console.log(`  ⚠ ${msg}`); }

function findConfig() {
  let dir = resolve('.');
  while (dir !== '/') {
    const candidate = join(dir, 'arc.config.json');
    if (existsSync(candidate)) return candidate;
    dir = join(dir, '..');
  }
  return null;
}
