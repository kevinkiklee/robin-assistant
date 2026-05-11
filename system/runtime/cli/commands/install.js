import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import readline from 'node:readline/promises';
import {
  discoverExistingHomes,
  ensureHome,
  packageRootDir,
  paths,
  pointerExists,
  readHostIntegrations,
  readPointer,
  recordHostTouchpoint,
  writePointer,
} from '../../../config/data-store.js';
import { readConfig, writeConfig } from '../../../config/paths.js';
import { getSecret, saveSecret } from '../../../config/secrets.js';
import { close, connect, defaultDbUrl } from '../../../data/db/client.js';
import { runMigrations } from '../../../data/db/migrate.js';
import { ensureHookShim } from '../../install/hook-shim.js';
import { installHooksToSettings, validateRobinResolvable } from '../../install/hooks-settings.js';
import { computeManifest, writeManifest } from '../../install/manifest.js';
import { migrateHome } from '../../install/migrate-home.js';
import { parseArgs } from '../args.js';
import { radio } from '../prompts.js';
import { doctorData } from './doctor.js';
import { mcpInstall } from './mcp-install.js';

const VALID_PROFILES = ['mxbai-1024', 'qwen3-4096', 'gemini-3072'];

const PROFILE_SUMMARIES = {
  'mxbai-1024': 'Local in-process. Default. ~1.3GB model, no extra setup.',
  'qwen3-4096':
    'Local via Ollama. Requires `ollama pull qwen3-embedding:8b` (~16GB). Best retrieval quality.',
  'gemini-3072':
    "Cloud API. Requires GEMINI_API_KEY. Free tier trains on input. Paid tier does not. By picking this you accept that all captured content goes to Google's servers.",
};

const OLLAMA_HOST = process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434';

async function defaultPrompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

function isInteractive() {
  return Boolean(process.stdin.isTTY);
}

async function chooseHome({ prompt, interactive, args, homeFlag }) {
  // If ROBIN_HOME is set in the environment, honour it directly (test mode, CI,
  // or user has pre-specified the location via env var). Mark as 'env' so the
  // install flow skips migration prompts and pointer writes.
  if (process.env.ROBIN_HOME) {
    return { home: resolve(process.env.ROBIN_HOME), action: 'env' };
  }
  // If already installed and not relocating/repairing, reuse.
  if (pointerExists() && !args.flags.relocate && !args.flags.repair) {
    const p = readPointer();
    return { home: p.home, action: 'reuse' };
  }
  const packageRoot = packageRootDir();
  const homeDir = homedir();
  if (homeFlag) {
    return { home: resolve(homeFlag), action: 'picked' };
  }
  // --yes: accept default (option 1) without prompting.
  if (args.flags.yes === true) {
    return { home: join(packageRoot, 'user-data'), action: 'picked-default' };
  }
  if (!interactive) {
    return { home: join(packageRoot, 'user-data'), action: 'picked-default' };
  }
  // Reinstall discovery: scan known locations. When --existing is provided,
  // use it as the sole candidate instead of the default scan.
  const existingFlag = typeof args.flags.existing === 'string' ? args.flags.existing : undefined;
  const discoveryOpts = existingFlag ? { candidates: [resolve(existingFlag)] } : undefined;
  const found = discoverExistingHomes(discoveryOpts);
  if (!pointerExists() && found.length > 0) {
    const reinstallOptions = found.map((f) => ({
      value: f.path,
      label: f.path,
      description: `${f.kind === 'marker' ? 'Robin data' : 'legacy v2 layout'}, last used ${f.lastUsed ?? 'unknown'}`,
    }));
    reinstallOptions.push({
      value: '__fresh__',
      label: 'Set up fresh (show picker)',
    });
    const choice = await radio({
      question:
        'This Robin install has no recorded data location. Scanning known locations…\n\nFound:',
      options: reinstallOptions,
      defaultIndex: 0,
      inputFn: prompt,
    });
    if (choice !== '__fresh__') {
      return { home: choice, action: 'recovered' };
    }
  }
  const chosen = await pickHome({ packageRoot, homedir: homeDir, inputFn: prompt });
  return { home: chosen, action: 'picked' };
}

async function pickProfile({ prompt, interactive, profileFlag }) {
  if (profileFlag) {
    if (!VALID_PROFILES.includes(profileFlag)) {
      console.error(`unknown profile: ${profileFlag}. Valid: ${VALID_PROFILES.join(', ')}`);
      process.exit(1);
    }
    return profileFlag;
  }
  if (!interactive) {
    console.error('no profile specified and not running interactively. Pass --profile <id>.');
    process.exit(1);
  }
  console.log('Robin uses an embedder for semantic recall. Choose a profile:');
  console.log('');
  console.log('  1) mxbai-1024  [default]');
  console.log(`     ${PROFILE_SUMMARIES['mxbai-1024']}`);
  console.log('');
  console.log('  2) qwen3-4096');
  console.log(`     ${PROFILE_SUMMARIES['qwen3-4096']}`);
  console.log('');
  console.log('  3) gemini-3072');
  console.log(`     ${PROFILE_SUMMARIES['gemini-3072']}`);
  console.log('');
  const answer = (await prompt('Choice [1]: ')).trim();
  if (answer === '' || answer === '1' || answer === 'mxbai-1024') return 'mxbai-1024';
  if (answer === '2' || answer === 'qwen3-4096') return 'qwen3-4096';
  if (answer === '3' || answer === 'gemini-3072') return 'gemini-3072';
  console.error(`invalid choice: ${answer}. Valid: 1, 2, 3.`);
  process.exit(1);
}

async function validateOllama({ fetchFn }) {
  let resp;
  try {
    resp = await fetchFn(`${OLLAMA_HOST}/api/tags`);
  } catch (e) {
    console.error(`Ollama unreachable at ${OLLAMA_HOST}: ${e.message}`);
    console.error('Install Ollama:');
    console.error('  brew install ollama        # macOS');
    console.error('  curl -fsSL https://ollama.com/install.sh | sh   # Linux');
    console.error('Then start it (`ollama serve`) and re-run `robin install`.');
    process.exit(1);
  }
  if (!resp.ok) {
    console.error(`Ollama at ${OLLAMA_HOST} returned ${resp.status}.`);
    console.error('Make sure ollama is running, then re-run `robin install`.');
    process.exit(1);
  }
  const json = await resp.json();
  const installed = (json.models ?? []).map((m) => m.name);
  const found = installed.some((n) => n.startsWith('qwen3-embedding:8b'));
  if (!found) {
    console.error('Ollama is running but qwen3-embedding:8b is not installed.');
    console.error('Run:');
    console.error('  ollama pull qwen3-embedding:8b');
    console.error('Then re-run `robin install`.');
    process.exit(1);
  }
}

async function validateGemini({ prompt, interactive, iUnderstand }) {
  if (!interactive && !iUnderstand) {
    console.error('');
    console.error('gemini-3072 sends all captured content to Google for embedding.');
    console.error(
      'Free tier trains on input. Paid tier does not. By picking gemini-3072 you accept this.',
    );
    console.error('Pass --i-understand to confirm in non-interactive mode, or run interactively.');
    process.exit(1);
  }
  if (interactive && !iUnderstand) {
    console.log('');
    console.log('Privacy notice for gemini-3072:');
    console.log('  All captured content (Gmail, Calendar, Lunch Money, Whoop, etc.) is sent');
    console.log("  to Google's Gemini API for embedding.");
    console.log('  Free tier trains on input. Paid tier or AI Studio opt-out does not.');
    console.log('');
    const answer = (await prompt('Type "i-understand" to continue, or anything else to abort: '))
      .trim()
      .toLowerCase();
    if (answer !== 'i-understand') {
      console.error('aborting: privacy disclosure not confirmed.');
      process.exit(1);
    }
  }
  const key = getSecret('GEMINI_API_KEY');
  if (key) return;
  if (!interactive) {
    console.error('GEMINI_API_KEY not set.');
    console.error('Set it with:');
    console.error('  robin secrets set GEMINI_API_KEY=<your-key>');
    console.error('Or set it interactively:');
    console.error('  robin secrets set GEMINI_API_KEY');
    process.exit(1);
  }
  const provided = (await prompt('GEMINI_API_KEY: ')).trim();
  if (!provided) {
    console.error('aborting: no key provided.');
    process.exit(1);
  }
  saveSecret('GEMINI_API_KEY', provided);
}

async function applyMigrations({ connectFn, closeFn, onDbReady }) {
  await ensureHome();
  const db = await connectFn({ engine: await defaultDbUrl() });
  try {
    const applied = await runMigrations(db, paths.source.migrations());
    const noun = applied.length === 1 ? 'migration' : 'migrations';
    const suffix = applied.length ? `: ${applied.join(', ')}` : '';
    console.log(`applied ${applied.length} ${noun}${suffix}`);
    if (onDbReady) await onDbReady(db);
  } finally {
    await closeFn(db);
  }
}

async function installHooksStep({ skipHooks }) {
  if (skipHooks) {
    console.log('skipping hook install (--no-hooks)');
    return;
  }
  const packageRoot = packageRootDir();
  await ensureHookShim();
  try {
    await validateRobinResolvable({ packageRoot });
  } catch (e) {
    console.error('');
    console.error(`hook install failed: ${e.message}`);
    console.error(
      'Robin hooks need either `robin` on PATH from a login shell OR an executable shim',
    );
    console.error(
      'at <package-root>/system/bin/robin-hook.sh. Install robin globally (`npm i -g robin-assistant`)',
    );
    console.error('or check filesystem permissions on the shim, then re-run `robin install`.');
    process.exit(1);
  }
  const { addedByHost } = await installHooksToSettings({
    homeDir: homedir(),
    packageRoot,
  });
  for (const [host, count] of Object.entries(addedByHost)) {
    const settingsPath = host === 'claude' ? '~/.claude/settings.json' : `~/.${host}/settings.json`;
    console.log(`installed ${count} robin hook entries to ${settingsPath}`);
  }
}

export async function pickHome({ packageRoot, homedir: homeDir, inputFn }) {
  const options = [
    {
      value: join(packageRoot, 'user-data'),
      label: 'Inside the package',
      description: `${join(packageRoot, 'user-data')} (moves with the package directory)`,
    },
    {
      value: join(homeDir, '.robin'),
      label: 'Hidden in your home dir',
      description: join(homeDir, '.robin'),
    },
    {
      value: join(homeDir, 'Documents', 'Robin'),
      label: 'Visible in Documents',
      description: join(homeDir, 'Documents', 'Robin'),
    },
    {
      value: '__custom__',
      label: 'Custom path…',
      customFn: async () => {
        for (;;) {
          const raw = (await inputFn('Custom path: ')).trim();
          if (!raw) {
            console.error('Empty path; try again.');
            continue;
          }
          const resolved = resolve(raw);
          const parent = dirname(resolved);
          if (!existsSync(parent)) {
            console.error(`Parent directory does not exist: ${parent}. Create it first.`);
            continue;
          }
          return resolved;
        }
      },
    },
  ];
  return await radio({
    question: 'Welcome to Robin. Where should Robin store your data?',
    options,
    defaultIndex: 0,
    inputFn,
  });
}

export async function relocate({ target, mode, stopDaemon, rewriteLaunchd, rewriteSystemd }) {
  if (!target || !mode) throw new TypeError('relocate: { target, mode } required');
  const ptr = readPointer();
  if (!ptr) throw new Error('relocate: no .robin-home exists; run `robin install` first');
  const source = ptr.home;
  if (!existsSync(source)) throw new Error(`relocate: source ${source} does not exist`);
  if (existsSync(target)) throw new Error(`relocate: target ${target} already exists`);
  if (stopDaemon) await stopDaemon();
  await migrateHome({ from: source, to: target, mode });
  writePointer({ home: target, installedBy: 'robin install --relocate' });
  process.env.ROBIN_HOME = target;
  const m = await readHostIntegrations();
  for (const e of m.entries) {
    if (e.expectedHome) {
      await recordHostTouchpoint({ ...e, expectedHome: target }, () => {});
    }
  }
  if (rewriteLaunchd) await rewriteLaunchd({ home: target });
  if (rewriteSystemd) await rewriteSystemd({ home: target });
}

export async function repair() {
  const { drift } = await doctorData();
  if (drift.length === 0) {
    console.log('Nothing to repair.');
    return;
  }
  await installHooksStep({ skipHooks: false });
  for (const d of drift) {
    console.log(`drift: ${d.path ?? '(home)'}: ${d.reason}`);
  }
  console.log('Re-applied hook entries. For plist/systemd drift, run: robin install');
}

/**
 * Determine the Robin home path and optional migration plan without executing
 * any side-effects. Extracted for testability.
 *
 * Returns one of:
 *   { home, action, migrationPlan: undefined }
 *   { home, action, migrationPlan: { from, mode } }
 *   { home, action, migrationPlan: { abort: true, reason } }
 */
export async function planInstallHome({
  args,
  interactive,
  prompt: _prompt,
  packageRoot,
  homedir: _homeDir,
  discoverFn,
}) {
  const homeFlag = typeof args.flags.home === 'string' ? args.flags.home : null;
  const yesFlag = args.flags.yes === true;
  const existingFlag = typeof args.flags.existing === 'string' ? args.flags.existing : null;
  const onExistingFlag =
    typeof args.flags['on-existing'] === 'string' ? args.flags['on-existing'] : null;
  const discover = discoverFn ?? discoverExistingHomes;

  // Resolve home.
  let home;
  let action;

  if (homeFlag) {
    home = resolve(homeFlag);
    action = 'picked';
  } else if (yesFlag || !interactive) {
    home = join(packageRoot, 'user-data');
    action = 'picked-default';
  } else {
    // Interactive picker — outside the scope of planInstallHome; callers that
    // need the picker should call chooseHome directly. This branch is only
    // reached if someone calls planInstallHome in an interactive context
    // without --home or --yes, which is valid when --existing is the point.
    home = join(packageRoot, 'user-data');
    action = 'picked-default';
  }

  // Discover existing data (honoring --existing).
  const discoveryOpts = existingFlag ? { candidates: [resolve(existingFlag)] } : undefined;
  const found = discover(discoveryOpts).filter((f) => f.path !== home);

  if (found.length === 0) {
    return { home, action, migrationPlan: undefined };
  }

  // Non-interactive or --yes: use --on-existing to decide. Default is 'abort'.
  const mode = onExistingFlag ?? 'abort';
  const VALID_MODES = ['move', 'copy', 'ignore', 'abort'];
  if (!VALID_MODES.includes(mode)) {
    return {
      home,
      action,
      migrationPlan: {
        abort: true,
        reason: `invalid --on-existing value: ${mode}. Valid: move, copy, ignore, abort`,
      },
    };
  }

  if (mode === 'abort') {
    const foundPaths = found.map((f) => f.path).join(', ');
    return {
      home,
      action,
      migrationPlan: {
        abort: true,
        reason: `existing data found at ${foundPaths}; aborting (pass --on-existing=ignore|move|copy)`,
      },
    };
  }

  if (mode === 'ignore') {
    return { home, action, migrationPlan: { ignore: true } };
  }

  // mode === 'move' | 'copy': use the first found candidate as source.
  return { home, action, migrationPlan: { from: found[0].path, mode } };
}

export async function install(argv = [], deps = {}) {
  const args = parseArgs(argv);
  const force = args.flags.force === true;
  const profileFlag = typeof args.flags.profile === 'string' ? args.flags.profile : null;
  const iUnderstand = args.flags['i-understand'] === true;
  const skipMcp = args.flags['no-mcp'] === true;
  const skipMigrate = args.flags['no-migrate'] === true;
  const skipHooks = args.flags['no-hooks'] === true;
  const hooksOnly = args.flags['hooks-only'] === true;
  const onExistingFlag =
    typeof args.flags['on-existing'] === 'string' ? args.flags['on-existing'] : null;
  const yesFlag = args.flags.yes === true;

  const prompt = deps.prompt ?? defaultPrompt;
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const interactive = typeof deps.interactive === 'boolean' ? deps.interactive : isInteractive();
  const supervise = deps.supervise ?? mcpInstall;
  const connectFn = deps.connect ?? connect;
  const closeFn = deps.close ?? close;
  const onDbReady = deps.onDbReady;

  // --relocate <path>: move Robin home to a new location.
  if (args.flags.relocate) {
    const target = typeof args.flags.relocate === 'string' ? args.flags.relocate : null;
    if (!target) {
      console.error('--relocate requires a target path: robin install --relocate <path>');
      process.exit(1);
    }
    const mode = args.flags['on-existing'] === 'copy' ? 'copy' : 'move';
    await relocate({ target, mode });
    return;
  }

  // --repair: re-apply hook entries from the manifest.
  if (args.flags.repair) {
    await repair();
    return;
  }

  // --hooks-only: short-circuit. Run ONLY the hook install (and PATH probe +
  // shim ensure). For repair after manual settings.json edits.
  if (hooksOnly) {
    await installHooksStep({ skipHooks: false });
    return;
  }

  // 1. Choose / recover / reuse the home.
  const homeFlag = typeof args.flags.home === 'string' ? args.flags.home : null;
  const { home, action } = await chooseHome({ prompt, interactive, args, homeFlag });
  process.env.ROBIN_HOME = home; // resolve subsequent steps to it
  if (action === 'reuse') {
    console.log(`Using existing Robin home: ${home}`);
  } else if (action === 'env') {
    console.log(`Using ROBIN_HOME from environment: ${home}`);
  } else if (action === 'recovered') {
    console.log(`Recovered Robin home from prior install: ${home}`);
  }

  // 2. Reinstall short-circuit.
  // Applies when the home was reused from pointer, env var, or already configured.
  if (action === 'reuse' || action === 'env' || action === 'recovered') {
    const existing = await readConfig();
    if (existing?.embedder_profile && !force) {
      console.log(
        `Robin is already configured for profile ${existing.embedder_profile}; pass --force to reconfigure.`,
      );
      return;
    }
  }

  // 3. Existing-data migration.
  //    - Interactive path: prompt for source and mode.
  //    - Non-interactive / --yes path: use --on-existing flag (default: abort).
  const nonInteractiveMigration = !interactive || yesFlag;

  if ((action === 'picked' || action === 'picked-default') && interactive && !yesFlag) {
    // Interactive branch: discover using --existing candidate if provided,
    // otherwise default scan.
    const existingFlag =
      typeof args.flags.existing === 'string' ? resolve(args.flags.existing) : null;
    const discoveryOpts = existingFlag ? { candidates: [existingFlag] } : undefined;
    const found = discoverExistingHomes(discoveryOpts).filter((f) => f.path !== home);
    if (found.length > 0) {
      const sources = found.map((f) => ({
        value: f.path,
        label: `${f.path} (${f.kind}, last used ${f.lastUsed ?? 'unknown'})`,
      }));
      sources.push({ value: '__skip__', label: 'Ignore — start fresh; existing left untouched' });
      const sourcePick = await radio({
        question: 'Existing Robin data found:',
        options: sources,
        defaultIndex: 0,
        inputFn: prompt,
      });
      if (sourcePick !== '__skip__') {
        const modePick = await radio({
          question: 'What should we do with it?',
          options: [
            { value: 'move', label: `Move to ${home}` },
            { value: 'copy', label: `Copy to ${home} (original kept)` },
            { value: 'abort', label: 'Abort install' },
          ],
          defaultIndex: 0,
          inputFn: prompt,
        });
        if (modePick === 'abort') {
          console.error('install aborted by user');
          process.exit(1);
        }
        if (existsSync(home)) {
          console.error(
            `target ${home} already exists; refusing to overwrite. Move it aside and re-run.`,
          );
          process.exit(1);
        }
        await migrateHome({ from: sourcePick, to: home, mode: modePick });
      }
    }
  } else if ((action === 'picked' || action === 'picked-default') && nonInteractiveMigration) {
    // Non-interactive / --yes branch: use --on-existing.
    const existingFlagVal =
      typeof args.flags.existing === 'string' ? resolve(args.flags.existing) : null;
    const discoveryOpts = existingFlagVal ? { candidates: [existingFlagVal] } : undefined;
    const found = discoverExistingHomes(discoveryOpts).filter((f) => f.path !== home);
    if (found.length > 0) {
      const mode = onExistingFlag ?? 'abort';
      if (mode === 'abort') {
        const foundPaths = found.map((f) => f.path).join(', ');
        console.error(
          `existing data found at ${foundPaths}; aborting (pass --on-existing=ignore|move|copy)`,
        );
        process.exit(1);
      } else if (mode === 'ignore') {
        // Silently skip migration; continue to install at chosen home.
        // --force is required when target exists and has no Robin marker.
        if (existsSync(home) && !force) {
          const isRobin =
            existsSync(join(home, '.robin-data')) ||
            existsSync(join(home, 'db', 'CURRENT')) ||
            existsSync(join(home, 'secrets', '.env'));
          if (!isRobin) {
            console.error(
              `target ${home} already exists and has no Robin marker; pass --force --on-existing=ignore to overwrite.`,
            );
            process.exit(1);
          }
        }
      } else if (mode === 'move' || mode === 'copy') {
        if (existsSync(home)) {
          console.error(
            `target ${home} already exists; refusing to overwrite. Move it aside and re-run.`,
          );
          process.exit(1);
        }
        await migrateHome({ from: found[0].path, to: home, mode });
      } else {
        console.error(`invalid --on-existing value: ${mode}. Valid: move, copy, ignore, abort`);
        process.exit(1);
      }
    }
  }

  // 4. Ensure home tree + marker (idempotent).
  await ensureHome();

  // 5. Pick profile.
  const profile = await pickProfile({ prompt, interactive, profileFlag });

  // 6. Per-profile validation.
  if (profile === 'qwen3-4096') {
    await validateOllama({ fetchFn });
  } else if (profile === 'gemini-3072') {
    await validateGemini({ prompt, interactive, iUnderstand });
  }
  // mxbai-1024: nothing to validate (model downloads on first use).

  // 7. Persist config.
  await writeConfig({
    embedder_profile: profile,
    installed_at: new Date().toISOString(),
  });
  console.log(`config: profile = ${profile}`);

  // 8. Run migrations.
  if (!skipMigrate) {
    await applyMigrations({ connectFn, closeFn, onDbReady });
  }

  // 9. Tamper baseline. Written after migrations + config so the manifest
  // captures the just-installed package version + supervisor file path.
  // Introspection on daemon boot compares against this baseline.
  try {
    const manifest = await computeManifest();
    await writeManifest(manifest);
    console.log(`introspection baseline written (${manifest.files.length} files)`);
  } catch (e) {
    console.warn(`introspection baseline failed (non-fatal): ${e.message}`);
  }

  // 10. Hook install — wire PreToolUse/UserPromptSubmit/SessionStart/Stop
  // entries into ~/.claude/settings.json + ~/.gemini/settings.json. Skipped
  // by --no-hooks. Failure here aborts the install (exit 1), since the
  // discretion / intuition / introspection faculties depend on these hooks.
  await installHooksStep({ skipHooks });

  // 11. Daemon supervision wire-up.
  if (!skipMcp) {
    console.log('');
    console.log('Installing MCP daemon supervision and host registration...');
    await supervise(argv);
  }

  // 12. Write the pointer last, so partial failures don't leave a half-pointed install.
  // Skip if home came from env var — env var IS the pointer in that mode
  // (tests, CI, user pre-specified $ROBIN_HOME).
  if (action !== 'env') {
    writePointer({
      home,
      installedBy: `robin install ${process.env.npm_package_version ?? 'unknown'}`,
    });
  }
  console.log(`Robin home is at: ${home}`);

  // 13. Next-step guidance.
  console.log('');
  console.log(`Robin installed (profile: ${profile}).`);
  console.log('Restart your Claude Code / Gemini CLI session to pick up the new MCP server.');
}
