import { existsSync, mkdirSync, readdirSync, cpSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { installHooks } from './install-hooks.js';
import { runPendingMigrations } from './migrate.js';

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
  const ud = join(workspaceDir, 'user-data');
  const skel = join(workspaceDir, 'system/skeleton');

  // Existing install: apply pending migrations and exit. This is the path
  // existing users hit after `npm install` post-`git pull`. Without this,
  // migrations would only run via `robin update`.
  if (existsSync(ud) && readdirSync(ud).length > 0) {
    try {
      const r = await runPendingMigrations(workspaceDir);
      if (r.applied.length > 0) {
        console.log(`postinstall: applied migrations ${r.applied.join(', ')}`);
      }
    } catch (err) {
      console.warn(`postinstall: migration apply skipped (${err.message})`);
    }
    return;
  }

  // Create directories
  mkdirSync(ud, { recursive: true });
  mkdirSync(join(workspaceDir, 'artifacts/input'), { recursive: true });
  mkdirSync(join(workspaceDir, 'artifacts/output'), { recursive: true });
  mkdirSync(join(workspaceDir, 'backup'), { recursive: true });

  // Copy skeleton → user-data
  if (existsSync(skel)) {
    for (const entry of readdirSync(skel)) {
      cpSync(join(skel, entry), join(ud, entry), { recursive: true });
    }
  }

  // Config: prompt or skip
  const isInteractive = !opts.ci && !process.env.CI && process.stdin.isTTY;
  const cfgPath = join(ud, 'robin.config.json');
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
    console.log('\nConfig saved to user-data/robin.config.json.');
  } else {
    console.log('Non-interactive mode. Edit user-data/robin.config.json before first session.');
  }

  // Apply baseline migrations
  try {
    await runPendingMigrations(workspaceDir);
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
    const { reconcile } = await import('./jobs/reconciler.js');
    const robinPath = `${process.execPath} ${join(workspaceDir, 'bin/robin.js')}`;
    const r = reconcile({ workspaceDir, robinPath });
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
