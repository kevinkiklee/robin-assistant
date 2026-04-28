import { existsSync, mkdirSync, readdirSync, cpSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { installHooks } from './install-hooks.js';
import { runPendingMigrations } from './migrate.js';

export async function setup(workspaceDir = process.cwd(), opts = {}) {
  const ud = join(workspaceDir, 'user-data');
  const skel = join(workspaceDir, 'system/skeleton');

  // Idempotent: skip if user-data populated
  if (existsSync(ud) && readdirSync(ud).length > 0) {
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
    cfg.user.timezone = (await rl.question('Timezone (e.g., America/New_York): ')).trim() || cfg.user.timezone || 'UTC';
    cfg.user.email = (await rl.question('Email (optional): ')).trim() || cfg.user.email || '';
    cfg.platform = (await rl.question('Platform [claude-code/cursor/gemini-cli/codex/windsurf/antigravity]: ')).trim() || 'claude-code';
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
