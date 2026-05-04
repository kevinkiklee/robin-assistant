import {
  existsSync,
  mkdirSync,
  readdirSync,
  cpSync,
  writeFileSync,
  readFileSync,
  lstatSync,
  realpathSync,
  symlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { installHooks } from './install-hooks.js';
import { runPendingMigrations } from '../migrate/apply.js';
import { ensureManifestFromScaffold } from '../lib/manifest.js';

// macOS resolves /var/folders → /private/var/folders, so a literal startsWith
// check against tmpdir() misses npm-postinstall subprocess paths. Compare via
// realpath so install-scenario e2e tests can't reach into the real user
// launchd domain via the launchd job adapter.
function isUnderTmpdir(workspaceDir) {
  if (!workspaceDir) return false;
  try {
    const tmpReal = realpathSync(tmpdir());
    const wdReal = existsSync(workspaceDir) ? realpathSync(workspaceDir) : workspaceDir;
    return wdReal.startsWith(tmpReal) || workspaceDir.startsWith(tmpdir());
  } catch {
    return workspaceDir.startsWith(tmpdir());
  }
}

function detectTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return 'UTC';
  }
}

function searchTimezones(query) {
  const all = Intl.supportedValuesOf('timeZone');
  const q = query.toLowerCase();
  return all.filter(tz => tz.toLowerCase().includes(q)).slice(0, 10);
}

// Ensure CLAUDE.md exists at the workspace root so Claude Code (and other
// agents that auto-load CLAUDE.md) pick up Robin's instructions. The file
// lives at packageRoot/CLAUDE.md and is symlinked rather than copied so
// `npm update -g robin-assistant` flows updates through automatically.
// Skipped when packageRoot is the workspace itself (cloned-repo dev) or
// when the user has authored their own CLAUDE.md at the workspace root.
function ensureClaudeMdLink(workspaceDir, packageRoot) {
  if (!packageRoot || packageRoot === workspaceDir) return;
  const src = join(packageRoot, 'CLAUDE.md');
  const dst = join(workspaceDir, 'CLAUDE.md');
  if (!existsSync(src)) return;
  try {
    lstatSync(dst);
    return; // anything at dst (file or symlink) — leave alone
  } catch {
    // ENOENT — proceed to create.
  }
  try {
    symlinkSync(src, dst);
    console.log(`postinstall: linked CLAUDE.md → ${src}`);
  } catch (err) {
    try {
      cpSync(src, dst);
      console.log(`postinstall: copied CLAUDE.md → ${dst} (symlink failed: ${err.message})`);
    } catch (cpErr) {
      console.warn(`postinstall: CLAUDE.md install skipped (${cpErr.message})`);
    }
  }
}

async function promptTimezone(rl) {
  const detected = detectTimezone();
  const answer = (await rl.question(`Timezone [${detected}] (or type to search): `)).trim();

  if (!answer) return detected;

  const all = Intl.supportedValuesOf('timeZone');
  if (all.includes(answer)) return answer;

  const matches = searchTimezones(answer);
  if (matches.length === 0) {
    console.log(`  No timezones matching "${answer}". Using ${detected}.`);
    return detected;
  }
  if (matches.length === 1) {
    console.log(`  → ${matches[0]}`);
    return matches[0];
  }

  console.log('  Matching timezones:');
  for (let i = 0; i < matches.length; i++) {
    console.log(`    ${i + 1}) ${matches[i]}`);
  }
  const pick = (await rl.question('  Pick a number (or Enter for #1): ')).trim();
  const idx = pick ? parseInt(pick, 10) - 1 : 0;
  return matches[idx] ?? matches[0];
}

export async function setup(workspaceDir = process.cwd(), opts = {}) {
  // Global installs (`npm i -g robin-assistant`) run postinstall with cwd set
  // to the package install dir — bootstrapping there would create a stray
  // user-data/ inside node_modules. Skip cleanly; users get a real workspace
  // by running `robin init --target <dir>` afterwards.
  if (!opts.fromInit && process.env.npm_config_global === 'true') {
    return;
  }

  const ud = join(workspaceDir, 'user-data');
  // Scaffold lives next to setup.js when robin-assistant is installed globally
  // (workspaceDir is then a fresh user dir, not the package dir). Callers can
  // override via opts.scaffoldDir; default is workspaceDir/system/scaffold for
  // backwards compatibility with cloned-repo installs.
  const scaffold = opts.scaffoldDir || join(workspaceDir, 'system/scaffold');

  const migrationsDir = opts.packageRoot ? join(opts.packageRoot, 'system/migrations') : undefined;

  // Existing install: apply pending migrations and exit. This is the path
  // existing users hit after `npm install` post-`git pull`. Without this,
  // migrations would only run via `robin update`.
  if (existsSync(ud) && readdirSync(ud).length > 0) {
    try {
      const r = await runPendingMigrations(workspaceDir, { migrationsDir });
      if (r.applied.length > 0) {
        console.log(`postinstall: applied migrations ${r.applied.join(', ')}`);
      }
    } catch (err) {
      console.warn(`postinstall: migration apply skipped (${err.message})`);
    }
    // Cycle-2b: ensure the security manifest exists for existing installs
    // (won't be added by scaffold-copy since user-data is non-empty).
    try {
      const m = ensureManifestFromScaffold(workspaceDir, opts.packageRoot);
      if (m.copied) {
        console.log('postinstall: copied scaffold security manifest → user-data/runtime/security/manifest.json');
      }
    } catch (err) {
      console.warn(`postinstall: manifest scaffold copy skipped (${err.message})`);
    }
    // Refresh user-data/runtime/scripts/ from scaffold. Auth/sync/write scripts are
    // templates whose path constants live in source — when migrations relocate
    // user-data layout (e.g. 0021), already-copied scripts retain stale paths
    // unless we refresh. Only top-level .js files in runtime/scripts/ are refreshed;
    // user-authored scripts (no scaffold counterpart) and the lib/ subtree pass
    // through. Files Kevin/users add (e.g. reconcile-bh-payboo.js) are preserved.
    try {
      const scaffoldScripts = join(scaffold, 'runtime/scripts');
      const userScripts = join(ud, 'runtime/scripts');
      if (existsSync(scaffoldScripts) && existsSync(userScripts)) {
        let refreshed = 0;
        for (const entry of readdirSync(scaffoldScripts)) {
          if (!entry.endsWith('.js')) continue;
          cpSync(join(scaffoldScripts, entry), join(userScripts, entry), { force: true });
          refreshed++;
        }
        if (refreshed > 0) {
          console.log(`postinstall: refreshed ${refreshed} script template(s) from scaffold`);
        }
      }
    } catch (err) {
      console.warn(`postinstall: scaffold scripts refresh skipped (${err.message})`);
    }
    ensureClaudeMdLink(workspaceDir, opts.packageRoot);
    return;
  }

  // Create directories
  mkdirSync(ud, { recursive: true });
  mkdirSync(join(ud, 'artifacts/input'), { recursive: true });
  mkdirSync(join(ud, 'artifacts/output'), { recursive: true });
  mkdirSync(join(ud, 'backup'), { recursive: true });

  // Copy scaffold → user-data (skip README.md, which documents the scaffold itself).
  // Scaffold mirrors the post-0021 layout, so a 1:1 copy lands user-data/ in the
  // canonical shape without further relocation.
  if (existsSync(scaffold)) {
    for (const entry of readdirSync(scaffold)) {
      if (entry === 'README.md') continue;
      cpSync(join(scaffold, entry), join(ud, entry), { recursive: true });
    }
  }

  ensureClaudeMdLink(workspaceDir, opts.packageRoot);

  // Config: prompt or skip. Prefer the post-0022 location; fall back to the
  // pre-0021 path for users mid-upgrade who haven't run migrations yet.
  const isInteractive = !opts.ci && !process.env.CI && process.stdin.isTTY;
  const oldCfgPath = join(ud, 'robin.config.json');
  const newCfgPath = join(ud, 'runtime/config/robin.config.json');
  const cfgPath = existsSync(newCfgPath) ? newCfgPath : oldCfgPath;
  let cfg = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, 'utf-8')) : {};

  if (isInteractive) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    cfg.user = cfg.user || {};
    cfg.user.name = (await rl.question('Your name: ')).trim() || cfg.user.name || '';
    cfg.user.timezone = await promptTimezone(rl);
    cfg.user.email = (await rl.question('Email (optional): ')).trim() || cfg.user.email || '';
    cfg.assistant = cfg.assistant || {};
    cfg.assistant.name = (await rl.question('Assistant name (default Robin): ')).trim() || 'Robin';
    rl.close();
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
    console.log('\nConfig saved to user-data/runtime/config/robin.config.json.');
  } else {
    console.log('Non-interactive mode. Edit user-data/runtime/config/robin.config.json before first session.');
  }

  // Apply baseline migrations
  try {
    await runPendingMigrations(workspaceDir, { migrationsDir });
  } catch (err) {
    console.warn(`Initial migration apply skipped: ${err.message}`);
  }

  // Install pre-commit hook
  try {
    await installHooks(workspaceDir);
  } catch (err) {
    console.warn(`Hook install skipped: ${err.message}`);
  }

  // Install scheduler entries for enabled jobs (cross-platform). Idempotent.
  // Skip in tempdir contexts: the launchd adapter writes plists to ~/Library/
  // LaunchAgents and bootstraps in the user's real gui/<uid> domain, which
  // would corrupt the user's real job plists (and bootout running services)
  // every time an e2e install scenario test runs.
  if (isUnderTmpdir(workspaceDir)) {
    return;
  }
  try {
    const { reconcile, resolveRobinArgv } = await import('../jobs/reconciler.js');
    const r = reconcile({ workspaceDir, argv: resolveRobinArgv(workspaceDir) });
    if (r && r.added && r.added.length > 0) {
      console.log(`Job scheduler entries installed: ${r.added.join(', ')}`);
    }
  } catch (err) {
    console.warn(`Job scheduler install skipped: ${err.message}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await setup();
}
