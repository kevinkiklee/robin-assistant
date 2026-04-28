import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { findConfig } from './lib/find-config.js';
import { migrateConfigFilename } from './lib/migrate-config-filename.js';
import { USER_DATA_FILES } from './lib/platforms.js';

/**
 * Returns true if `version` is >= `target` using numeric semver comparison.
 * Avoids the string comparison pitfall where '10.0.0' < '2.0.0' lexicographically.
 */
function versionAtLeast(version, target) {
  const v = version.split('.').map(Number);
  const t = target.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((v[i] || 0) > (t[i] || 0)) return true;
    if ((v[i] || 0) < (t[i] || 0)) return false;
  }
  return true;
}

export async function validate() {
  const configPath = findConfig();
  if (!configPath) {
    console.error("Error: No Robin workspace found. Run 'robin init' to create one.");
    process.exit(1);
  }
  const workspaceDir = join(configPath, '..');
  const __migration = migrateConfigFilename(workspaceDir);
  if (__migration.migrated) {
    console.log('Migrated arc.config.json → robin.config.json');
  }
  const result = await validateInDir(workspaceDir);
  console.log(`\n${result.issues === 0 ? 'All checks passed.' : `${result.issues} issue(s) found.`}`);
  process.exit(result.issues > 0 ? 1 : 0);
}

export async function validateInDir(workspaceDir) {
  let issues = 0;

  const configPath = join(workspaceDir, 'robin.config.json');
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    ok('robin.config.json is valid JSON');
    if (!config.user?.name) { warn('user.name not set'); }
    if (!config.user?.timezone) { warn('user.timezone not set'); }
    if (!config.platform) { warn('platform not set'); }
  } catch {
    fail('robin.config.json is invalid or missing'); issues++;
  }

  for (const file of ['AGENTS.md', 'startup.md', 'capture-rules.md', 'integrations.md']) {
    if (existsSync(join(workspaceDir, file))) {
      ok(`${file} exists`);
    } else {
      fail(`${file} MISSING`); issues++;
    }
  }

  for (const file of USER_DATA_FILES) {
    if (existsSync(join(workspaceDir, file))) {
      ok(`${file} exists`);
    } else {
      fail(`${file} MISSING`); issues++;
    }
  }

  for (const file of ['state/sessions.md', 'state/dream-state.md']) {
    if (existsSync(join(workspaceDir, file))) {
      ok(`${file} exists`);
    } else {
      fail(`${file} MISSING`); issues++;
    }
  }
  if (existsSync(join(workspaceDir, 'state', 'locks'))) {
    ok('state/locks/ exists');
  } else {
    fail('state/locks/ MISSING'); issues++;
  }

  if (existsSync(join(workspaceDir, 'protocols', 'INDEX.md'))) {
    ok('protocols/INDEX.md exists');
  } else {
    fail('protocols/INDEX.md MISSING'); issues++;
  }

  const locksDir = join(workspaceDir, 'state', 'locks');
  if (existsSync(locksDir)) {
    const locks = readdirSync(locksDir).filter(f => f.endsWith('.lock'));
    for (const lock of locks) {
      const content = readFileSync(join(locksDir, lock), 'utf-8');
      const match = content.match(/acquired:\s*(.+)/);
      if (match) {
        const acquired = new Date(match[1].trim());
        const age = (Date.now() - acquired.getTime()) / 1000 / 60;
        if (age > 5) {
          warn(`Stale lock: ${lock} (${Math.round(age)} minutes old)`);
        }
      }
    }
  }

  try {
    const { execSync } = await import('child_process');
    const remotes = execSync('git remote -v', { cwd: workspaceDir, encoding: 'utf-8' }).trim();
    if (remotes) {
      fail('Git remotes found — this workspace may contain personal data!'); issues++;
    } else {
      ok('No git remotes (local-only)');
    }
  } catch {
    ok('No git repository or no remotes');
  }

  // Index integrity (v2.1.0+)
  try {
    const config = JSON.parse(readFileSync(join(workspaceDir, 'robin.config.json'), 'utf-8'));
    if (config.version && versionAtLeast(config.version, '2.1.0')) {
      if (existsSync(join(workspaceDir, 'index'))) {
        ok('index/ directory exists');
      } else {
        fail('index/ directory MISSING (run robin migrate-index)'); issues++;
      }

      if (existsSync(join(workspaceDir, 'manifest.md'))) {
        ok('manifest.md exists');
      } else {
        fail('manifest.md MISSING'); issues++;
      }

      const expectedIndexFiles = [
        'profile.idx.md', 'knowledge.idx.md', 'tasks.idx.md',
        'journal.idx.md', 'decisions.idx.md', 'self-improvement.idx.md',
        'inbox.idx.md', 'trips.idx.md',
      ];
      for (const f of expectedIndexFiles) {
        if (existsSync(join(workspaceDir, 'index', f))) {
          ok(`index/${f} exists`);
        } else {
          fail(`index/${f} MISSING`); issues++;
        }
      }

      if (config.indexing?.status) {
        ok(`indexing status: ${config.indexing.status}`);
      } else {
        warn('indexing status not set in config');
      }
    }
  } catch { /* config already validated above */ }

  return { issues };
}

function ok(msg) { console.log(`  ✓ ${msg}`); }
function fail(msg) { console.log(`  ✗ ${msg}`); }
function warn(msg) { console.log(`  ⚠ ${msg}`); }
