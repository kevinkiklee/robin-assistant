#!/usr/bin/env node
// npm/pnpm/yarn `postinstall` entry. Decides whether to invoke
// `robin install --auto` (fresh install) or `robin install --upgrade`
// (already installed — idempotent refresh of migrations, hooks, manifest,
// supervisor; preserves config). Never fails the install: any error becomes
// a printed hint and exit 0, so a setup glitch can't brick `npm install`.
//
// Gating:
//   - Skip if ROBIN_SKIP_INSTALL is set (explicit opt-out).
//   - Skip in CI environments (CI=true).
//   - Skip on global install (npm_config_global=true). Print a manual hint.
//   - Skip when installed transitively as a dep (INIT_CWD !== process.cwd()).
//   - Skip on Windows (daemon supervision unsupported).
//
// Pass-through env flags (each maps to a `robin install` switch):
//   ROBIN_SKIP_MCP          → --no-mcp
//   ROBIN_SKIP_DAEMON       → --no-start
//   ROBIN_SKIP_HOOKS        → --no-hooks
//   ROBIN_SKIP_AGENTS_MD    → --no-agents-md
//   ROBIN_SKIP_SUPERVISE    → --no-supervise
//   ROBIN_SKIP_REGISTER     → --no-register
//   ROBIN_SKIP_SURREAL      → --no-surreal

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '../../..');

function alreadyInstalled() {
  // Pointer at package root means a prior install completed successfully.
  if (existsSync(join(packageRoot, '.robin-home'))) return true;
  // Or the default home (<package_root>/user-data/) already has a Robin
  // data marker — covers users who ran `robin install` before the postinstall
  // existed. Skipping here prevents `writeConfig` from clobbering their
  // existing config (e.g. hooks.disabled, custom embedder_profile). Accept
  // either the v2 marker (runtime/install/.marker.json) or the legacy v1
  // marker (.robin-data) during the transition window.
  const home = join(packageRoot, 'user-data');
  if (existsSync(join(home, 'runtime', 'install', '.marker.json'))) return true;
  if (existsSync(join(home, '.robin-data'))) return true;
  return false;
}

function shouldRun() {
  if (process.env.ROBIN_SKIP_INSTALL) {
    return { run: false };
  }
  if (process.env.CI) {
    return { run: false };
  }
  if (process.env.npm_config_global === 'true') {
    return {
      run: false,
      advise: 'Robin installed globally. Run `robin install` to finish setup.',
    };
  }
  // Transitive install detection: when this package is a dep of another
  // project, INIT_CWD (where npm was invoked) differs from process.cwd()
  // (the install location, e.g. consumer/node_modules/robin-assistant).
  const initCwd = process.env.INIT_CWD;
  if (initCwd && resolve(initCwd) !== resolve(process.cwd())) {
    return { run: false };
  }
  if (platform() === 'win32') {
    return {
      run: false,
      advise:
        'Robin auto-setup is not supported on Windows yet. Run `node system/bin/robin install` manually.',
    };
  }
  if (alreadyInstalled()) {
    // Upgrade path: idempotent refresh, no prompts, config preserved.
    return { run: true, upgrade: true };
  }
  return { run: true };
}

const decision = shouldRun();
if (!decision.run) {
  if (decision.advise) {
    console.log(`Robin: ${decision.advise}`);
  }
  process.exit(0);
}

const binPath = resolve(here, '../../bin/robin');

const flags = decision.upgrade ? ['install', '--upgrade'] : ['install', '--auto'];
if (process.env.ROBIN_SKIP_MCP) flags.push('--no-mcp');
if (process.env.ROBIN_SKIP_DAEMON) flags.push('--no-start');
if (process.env.ROBIN_SKIP_HOOKS) flags.push('--no-hooks');
if (process.env.ROBIN_SKIP_AGENTS_MD) flags.push('--no-agents-md');
if (process.env.ROBIN_SKIP_SUPERVISE) flags.push('--no-supervise');
if (process.env.ROBIN_SKIP_REGISTER) flags.push('--no-register');
if (process.env.ROBIN_SKIP_SURREAL) flags.push('--no-surreal');

// Clear ROBIN_SKIP_INSTALL in the child env so first-run-init can still trigger
// later if this run somehow no-ops without writing the pointer.
const childEnv = { ...process.env };
delete childEnv.ROBIN_SKIP_INSTALL;

const child = spawn(process.execPath, [binPath, ...flags], {
  stdio: 'inherit',
  env: childEnv,
});

child.on('exit', (code) => {
  if (code !== 0) {
    console.log('');
    console.log(
      `Robin: auto-setup exited ${code}. Run \`node system/bin/robin install\` to retry and see full output.`,
    );
  }
  // Always exit 0 — never block npm install on setup failure.
  process.exit(0);
});

child.on('error', (err) => {
  console.log(
    `Robin: could not launch auto-setup (${err.message}). Run \`node system/bin/robin install\` to finish setup manually.`,
  );
  process.exit(0);
});
