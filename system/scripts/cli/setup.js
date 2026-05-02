import { existsSync, mkdirSync, readdirSync, cpSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { installHooks } from './install-hooks.js';
import { runPendingMigrations } from '../migrate/apply.js';
import { ensureManifestFromScaffold } from '../lib/manifest.js';

const PLATFORMS = ['claude-code', 'cursor', 'gemini-cli', 'codex', 'antigravity'];

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

async function promptPlatform(rl) {
  console.log('Platform:');
  for (let i = 0; i < PLATFORMS.length; i++) {
    console.log(`  ${i + 1}) ${PLATFORMS[i]}`);
  }
  const pick = (await rl.question('Pick a number [1]: ')).trim();
  const idx = pick ? parseInt(pick, 10) - 1 : 0;
  return PLATFORMS[idx] ?? PLATFORMS[0];
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
        console.log('postinstall: copied scaffold security manifest → user-data/ops/security/manifest.json');
      }
    } catch (err) {
      console.warn(`postinstall: manifest scaffold copy skipped (${err.message})`);
    }
    // Refresh user-data/ops/scripts/ from scaffold. Auth/sync/write scripts are
    // templates whose path constants live in source — when migrations relocate
    // user-data layout (e.g. 0021), already-copied scripts retain stale paths
    // unless we refresh. Only top-level .js files in ops/scripts/ are refreshed;
    // user-authored scripts (no scaffold counterpart) and the lib/ subtree pass
    // through. Files Kevin/users add (e.g. reconcile-bh-payboo.js) are preserved.
    try {
      const scaffoldScripts = join(scaffold, 'ops/scripts');
      const userScripts = join(ud, 'ops/scripts');
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
    return;
  }

  // Create directories
  mkdirSync(ud, { recursive: true });
  mkdirSync(join(workspaceDir, 'artifacts/input'), { recursive: true });
  mkdirSync(join(workspaceDir, 'artifacts/output'), { recursive: true });
  mkdirSync(join(workspaceDir, 'backup'), { recursive: true });

  // Copy scaffold → user-data (skip README.md, which documents the scaffold itself).
  // Scaffold mirrors the post-0021 layout, so a 1:1 copy lands user-data/ in the
  // canonical shape without further relocation.
  if (existsSync(scaffold)) {
    for (const entry of readdirSync(scaffold)) {
      if (entry === 'README.md') continue;
      cpSync(join(scaffold, entry), join(ud, entry), { recursive: true });
    }
  }

  // Config: prompt or skip. Prefer the post-0021 location; fall back to the
  // pre-0021 path for users mid-upgrade who haven't run migration 0021 yet.
  const isInteractive = !opts.ci && !process.env.CI && process.stdin.isTTY;
  const oldCfgPath = join(ud, 'robin.config.json');
  const newCfgPath = join(ud, 'ops/config/robin.config.json');
  const cfgPath = existsSync(newCfgPath) ? newCfgPath : oldCfgPath;
  let cfg = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, 'utf-8')) : {};

  if (isInteractive) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    cfg.user = cfg.user || {};
    cfg.user.name = (await rl.question('Your name: ')).trim() || cfg.user.name || '';
    cfg.user.timezone = await promptTimezone(rl);
    cfg.user.email = (await rl.question('Email (optional): ')).trim() || cfg.user.email || '';
    cfg.platform = await promptPlatform(rl);
    cfg.assistant = cfg.assistant || {};
    cfg.assistant.name = (await rl.question('Assistant name (default Robin): ')).trim() || 'Robin';
    rl.close();
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
    console.log('\nConfig saved to user-data/ops/config/robin.config.json.');
  } else {
    console.log('Non-interactive mode. Edit user-data/ops/config/robin.config.json before first session.');
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
