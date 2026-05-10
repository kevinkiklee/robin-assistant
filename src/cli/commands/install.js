import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import readline from 'node:readline/promises';
import { close, connect } from '../../db/client.js';
import { runMigrations } from '../../db/migrate.js';
import { ensureHookShim } from '../../install/hook-shim.js';
import { installHooksToSettings, validateRobinResolvable } from '../../install/hooks-settings.js';
import { computeManifest, writeManifest } from '../../install/manifest.js';
import { readConfig, writeConfig } from '../../runtime/config.js';
import { ensureHome, packageRootDir, paths } from '../../runtime/home.js';
import { getSecret, saveSecret } from '../../secrets/dotenv-io.js';
import { parseArgs } from '../args.js';
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

async function detectLegacyHome({ prompt, interactive, force }) {
  const legacy = join(homedir(), '.robin');
  if (!existsSync(legacy)) return;
  console.log('! Detected legacy ~/.robin/ data from v1.');
  console.log('! Robin v2 stores data inside the package at <package_root>/user-data/.');
  console.log('! Migrate manually: see docs (or wait for `robin migrate-v1` in Phase 3b).');
  if (!interactive) {
    if (force) {
      console.log('! Continuing anyway (--force).');
      return;
    }
    console.error(
      'aborting: legacy ~/.robin/ detected and not running interactively. Pass --force to ignore.',
    );
    process.exit(1);
  }
  const answer = (await prompt('! Continue installing v2 anyway? (y/N) ')).trim().toLowerCase();
  if (answer !== 'y' && answer !== 'yes') {
    console.error('aborting: user declined to continue.');
    process.exit(1);
  }
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
  const p = paths();
  const db = await connectFn({ engine: `rocksdb://${p.db}` });
  try {
    const applied = await runMigrations(db, p.migrationsDir);
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
      'at <package-root>/bin/robin-hook.sh. Install robin globally (`npm i -g robin-assistant`)',
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

export async function install(argv = [], deps = {}) {
  const args = parseArgs(argv);
  const force = args.flags.force === true;
  const profileFlag = typeof args.flags.profile === 'string' ? args.flags.profile : null;
  const iUnderstand = args.flags['i-understand'] === true;
  const skipMcp = args.flags['no-mcp'] === true;
  const skipMigrate = args.flags['no-migrate'] === true;
  const skipHooks = args.flags['no-hooks'] === true;
  const hooksOnly = args.flags['hooks-only'] === true;

  const prompt = deps.prompt ?? defaultPrompt;
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const interactive = typeof deps.interactive === 'boolean' ? deps.interactive : isInteractive();
  const supervise = deps.supervise ?? mcpInstall;
  const connectFn = deps.connect ?? connect;
  const closeFn = deps.close ?? close;
  const onDbReady = deps.onDbReady;

  // --hooks-only: short-circuit. Run ONLY the hook install (and PATH probe +
  // shim ensure). For repair after manual settings.json edits.
  if (hooksOnly) {
    await installHooksStep({ skipHooks: false });
    return;
  }

  // 1. Detect legacy ~/.robin/.
  await detectLegacyHome({ prompt, interactive, force });

  // 2. Reinstall short-circuit.
  const existing = await readConfig();
  if (existing?.embedder_profile && !force) {
    console.log(
      `Robin is already configured for profile ${existing.embedder_profile}; pass --force to reconfigure.`,
    );
    return;
  }

  // 3. Pick profile.
  const profile = await pickProfile({ prompt, interactive, profileFlag });

  // 4. Per-profile validation.
  if (profile === 'qwen3-4096') {
    await validateOllama({ fetchFn });
  } else if (profile === 'gemini-3072') {
    await validateGemini({ prompt, interactive, iUnderstand });
  }
  // mxbai-1024: nothing to validate (model downloads on first use).

  // 5. Persist config.
  await ensureHome();
  await writeConfig({
    embedder_profile: profile,
    installed_at: new Date().toISOString(),
  });
  console.log(`config: profile = ${profile}`);

  // 6. Run migrations.
  if (!skipMigrate) {
    await applyMigrations({ connectFn, closeFn, onDbReady });
  }

  // 7. Tamper baseline. Written after migrations + config so the manifest
  // captures the just-installed package version + supervisor file path.
  // Tamper-check on daemon boot compares against this baseline.
  try {
    const manifest = await computeManifest();
    await writeManifest(manifest);
    console.log(`tamper baseline written (${manifest.files.length} files)`);
  } catch (e) {
    console.warn(`tamper baseline failed (non-fatal): ${e.message}`);
  }

  // 8. Hook install — wire PreToolUse/UserPromptSubmit/SessionStart/Stop
  // entries into ~/.claude/settings.json + ~/.gemini/settings.json. Skipped
  // by --no-hooks. Failure here aborts the install (exit 1), since v2's
  // safety floor depends on these hooks firing.
  await installHooksStep({ skipHooks });

  // 9. Daemon supervision wire-up.
  if (!skipMcp) {
    console.log('');
    console.log('Installing MCP daemon supervision and host registration...');
    await supervise(argv);
  }

  // 10. Next-step guidance.
  console.log('');
  console.log(`Robin installed (profile: ${profile}).`);
  console.log('Restart your Claude Code / Gemini CLI session to pick up the new MCP server.');
}
