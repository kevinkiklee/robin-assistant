// Wires the secret guard (PreToolUse) and redaction (PostToolUse) hooks into
// ~/.claude/settings.json for every interactive Claude session on this Mac.
// Same signature-substring find/replace as lib/claude-hooks/install.ts, minus
// its `|| true` (these hooks must not fail open). Robin's own Agent SDK
// sessions (system/agent/sdk.ts) don't load user settings, so they get neither
// hook; they are bounded by runAgent's tool allowlist and sandbox instead.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveUserDataDir } from '../paths.ts';
import { secretsPaths } from './store.ts';

/** Every secret hook command contains this; nothing else should. */
export const SECRET_HOOK_SIGNATURE = '/lib/secrets/hooks/';

const HOOK_TIMEOUT_SECONDS = 10;

export interface SecretHookPaths {
  nodeBin: string;
  distRoot: string;
  userData: string;
}

export interface SecretInstallOptions extends Partial<SecretHookPaths> {
  /** Override HOME for tests. */
  home?: string;
}

export interface SecretInstallResult {
  path: string;
  /** True when a prior secret hook entry was replaced (install) or removed (uninstall). */
  replaced: boolean;
  /** Set when the compiled guard is missing: the hooks are installed but can't run yet. */
  warning?: string;
}

interface HookEntry {
  type: string;
  command: string;
  timeout?: number;
  /** PreToolUse only: a hook that crashes or times out blocks the call. */
  onFailure?: 'block';
}

interface MatcherGroup {
  matcher?: string;
  hooks?: HookEntry[];
}

interface SettingsShape {
  hooks?: Record<string, MatcherGroup[] | undefined>;
  [k: string]: unknown;
}

/**
 * The repo's dist dir, from this module's own location: `system/lib/secrets/`
 * under tsx and `dist/lib/secrets/` compiled are both three levels below the repo.
 */
export function defaultDistRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'dist');
}

/** Paths go inside single quotes; refuse anything that could break out or expand. */
function quote(label: string, value: string): string {
  if (/['\n\r$]/.test(value)) {
    throw new Error(`secret hooks: ${label} contains a quote, newline or $: refusing to install`);
  }
  return `'${value}'`;
}

function hookInvocation(p: SecretHookPaths, script: string): string {
  const userData = quote('userData', p.userData);
  const nodeBin = quote('nodeBin', p.nodeBin);
  const target = quote('distRoot', `${p.distRoot}/lib/secrets/hooks/${script}`);
  return `ROBIN_USER_DATA_DIR=${userData} ${nodeBin} ${target}`;
}

/**
 * PreToolUse command. The shell fast path exits 0 before Node starts unless a
 * window file exists (any type), the runtime dir can't be searched (so its
 * absence can't be confirmed), or the call mentions `robin secret arm` or the
 * redaction marker (deliberate supersets of the guard's exact checks; node
 * applies the exact ones). stdin is read once and re-fed byte-for-byte (the
 * `x` sentinel keeps trailing newlines that `$(…)` would strip). Any node
 * failure becomes exit 2, the only exit code Claude Code treats as blocking.
 */
export function secretGuardCommand(p: SecretHookPaths): string {
  const windowPath = secretsPaths(p.userData).window;
  const window = quote('userData', windowPath);
  const runtime = quote('userData', dirname(windowPath));
  const run = hookInvocation(p, 'guard.js');
  return (
    `in=$(cat; printf x); in=\${in%x}; ` +
    `[ -e ${window} ] || [ ! -x ${runtime} ] || ` +
    `case "$in" in *'robin secret arm'*|*'[REDACTED-SECRET]'*) ;; *) exit 0;; esac; ` +
    `printf '%s' "$in" | ${run} ` +
    `|| { echo 'secret guard failed; blocking while a secret window may be open' >&2; exit 2; }`
  );
}

/** PostToolUse command: redaction and window close-out. */
export function secretPostToolCommand(p: SecretHookPaths): string {
  return hookInvocation(p, 'post-tool.js');
}

function settingsPathFor(home: string): string {
  return join(home, '.claude', 'settings.json');
}

function readSettings(path: string): SettingsShape {
  if (!existsSync(path)) return {};
  // A corrupt settings.json throws: rewriting it would wipe the user's settings.
  return JSON.parse(readFileSync(path, 'utf8')) as SettingsShape;
}

function writeSettings(path: string, settings: SettingsShape): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(settings, null, 2));
  renameSync(tmp, path);
}

/** Drops secret hook entries from the groups; returns the rest and whether any went. */
function strip(groups: MatcherGroup[] | undefined): { kept: MatcherGroup[]; removed: boolean } {
  let removed = false;
  const kept: MatcherGroup[] = [];
  for (const group of groups ?? []) {
    const hooks = (group.hooks ?? []).filter((h) => {
      const ours = typeof h.command === 'string' && h.command.includes(SECRET_HOOK_SIGNATURE);
      if (ours) removed = true;
      return !ours;
    });
    if (hooks.length === (group.hooks ?? []).length) kept.push(group);
    else if (hooks.length > 0) kept.push({ ...group, hooks });
  }
  return { kept, removed };
}

const EVENTS = ['PreToolUse', 'PostToolUse'] as const;

/**
 * Adds (or replaces) the guard and redaction hooks. Idempotent; other hooks,
 * including the user's own PreToolUse groups, are left as they were.
 */
export function installSecretHooks(opts: SecretInstallOptions = {}): SecretInstallResult {
  const home = opts.home ?? homedir();
  const p: SecretHookPaths = {
    nodeBin: opts.nodeBin ?? process.execPath,
    distRoot: opts.distRoot ?? defaultDistRoot(),
    userData: opts.userData ?? resolveUserDataDir(),
  };
  // Build both commands first so a refused path leaves settings.json untouched.
  const commands = { PreToolUse: secretGuardCommand(p), PostToolUse: secretPostToolCommand(p) };
  const path = settingsPathFor(home);
  const settings = readSettings(path);
  if (!settings.hooks) settings.hooks = {};
  let replaced = false;
  for (const event of EVENTS) {
    const { kept, removed } = strip(settings.hooks[event]);
    if (removed) replaced = true;
    // PostToolUse redacts only successful calls: a FAILED call's output goes to
    // PostToolUseFailure, which can't replace output, so it is never redacted
    // (the rule file tells agents not to print secrets even while debugging).
    const entry: HookEntry = {
      type: 'command',
      command: commands[event],
      timeout: HOOK_TIMEOUT_SECONDS,
    };
    if (event === 'PreToolUse') entry.onFailure = 'block';
    kept.push({ matcher: '.*', hooks: [entry] });
    settings.hooks[event] = kept;
  }
  writeSettings(path, settings);
  const guardJs = join(p.distRoot, 'lib', 'secrets', 'hooks', 'guard.js');
  return existsSync(guardJs)
    ? { path, replaced }
    : { path, replaced, warning: `${guardJs} not found: run pnpm build` };
}

/** Removes only the secret hook entries (a no-op when none are installed). */
export function uninstallSecretHooks(opts: { home?: string } = {}): SecretInstallResult {
  const path = settingsPathFor(opts.home ?? homedir());
  if (!existsSync(path)) return { path, replaced: false };
  let settings: SettingsShape;
  try {
    settings = readSettings(path);
  } catch {
    return { path, replaced: false };
  }
  if (!settings.hooks) return { path, replaced: false };
  let replaced = false;
  for (const event of EVENTS) {
    const { kept, removed } = strip(settings.hooks[event]);
    if (!removed) continue;
    replaced = true;
    if (kept.length) settings.hooks[event] = kept;
    else delete settings.hooks[event];
  }
  if (replaced) writeSettings(path, settings);
  return { path, replaced };
}
