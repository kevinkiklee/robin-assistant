import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

const PILLAR_USER_FILES = [
  'profile.md', 'knowledge.md', 'tasks.md', 'decisions.md',
  'journal.md', 'inbox.md', 'self-improvement.md', 'integrations.md',
];

export async function validateInDir(workspaceDir) {
  let issues = 0;
  const ud = join(workspaceDir, 'user-data');

  // config
  const configPath = join(ud, 'robin.config.json');
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    ok('user-data/robin.config.json is valid JSON');
    if (!config.user?.name) warn('user.name not set');
    if (!config.user?.timezone) warn('user.timezone not set');
    if (!config.platform) warn('platform not set');
  } catch {
    fail('user-data/robin.config.json missing or invalid'); issues++;
  }

  // pillar files
  for (const f of PILLAR_USER_FILES) {
    if (existsSync(join(ud, f))) ok(`user-data/${f} exists`);
    else { fail(`user-data/${f} MISSING`); issues++; }
  }

  // state
  for (const f of ['state/sessions.md', 'state/dream-state.md']) {
    if (existsSync(join(ud, f))) ok(`user-data/${f} exists`);
    else { fail(`user-data/${f} MISSING`); issues++; }
  }
  if (existsSync(join(ud, 'state/locks'))) ok('user-data/state/locks/ exists');
  else { fail('user-data/state/locks/ MISSING'); issues++; }

  // privacy: gitignore guard
  try {
    execSync('git check-ignore -q user-data/', { cwd: workspaceDir, stdio: 'pipe' });
    ok('user-data/ is gitignored');
  } catch {
    fail('user-data/ is NOT gitignored — privacy at risk'); issues++;
  }

  // privacy: no staged user data
  try {
    const staged = execSync('git diff --cached --name-only', { cwd: workspaceDir, encoding: 'utf-8' })
      .split('\n').filter(Boolean)
      .filter(f => /^(user-data|artifacts|backup)\//.test(f));
    if (staged.length === 0) ok('no personal data staged');
    else { fail(`staged personal data: ${staged.join(', ')}`); issues++; }
  } catch { /* not a git repo — fine in tests */ }

  // hook
  if (existsSync(join(workspaceDir, '.git/hooks/pre-commit'))) {
    ok('pre-commit hook installed');
  } else {
    warn('pre-commit hook not installed — run `node system/scripts/install-hooks.js`');
  }

  // stale locks
  const locksDir = join(ud, 'state/locks');
  if (existsSync(locksDir)) {
    for (const lock of readdirSync(locksDir).filter(f => f.endsWith('.lock'))) {
      const content = readFileSync(join(locksDir, lock), 'utf-8');
      const m = content.match(/acquired:\s*(.+)/);
      if (m) {
        const age = (Date.now() - new Date(m[1].trim()).getTime()) / 60000;
        if (age > 5) warn(`stale lock: ${lock} (${Math.round(age)}m)`);
      }
    }
  }

  return { issues };
}

function ok(msg) { console.log(`  ✓ ${msg}`); }
function fail(msg) { console.log(`  ✗ ${msg}`); }
function warn(msg) { console.log(`  ⚠ ${msg}`); }
