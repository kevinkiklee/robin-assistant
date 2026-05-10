import { spawnSync } from 'node:child_process';
import {
  constants,
  accessSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { paths } from '../runtime/home.js';

/**
 * Per spec §10:
 * - Claude Code: PreToolUse (Bash), UserPromptSubmit, SessionStart, Stop.
 * - Gemini CLI: PreToolUse (Bash), SessionStart, Stop. (No UserPromptSubmit.)
 *
 * Hook-phase shapes (no matcher unless noted):
 *   PreToolUse Bash → matcher='Bash', subcommand='bash-policy'
 *   UserPromptSubmit → no matcher,    subcommand='auto-recall'
 *   SessionStart     → no matcher,    subcommand='session-start'
 *   Stop             → no matcher,    subcommand='stop'
 */
const CLAUDE_PHASES = [
  { phase: 'PreToolUse', matcher: 'Bash', subcommand: 'bash-policy' },
  { phase: 'UserPromptSubmit', matcher: null, subcommand: 'auto-recall' },
  { phase: 'SessionStart', matcher: null, subcommand: 'session-start' },
  { phase: 'Stop', matcher: null, subcommand: 'stop' },
];

const GEMINI_PHASES = [
  { phase: 'PreToolUse', matcher: 'Bash', subcommand: 'bash-policy' },
  { phase: 'SessionStart', matcher: null, subcommand: 'session-start' },
  { phase: 'Stop', matcher: null, subcommand: 'stop' },
];

const HOSTS = [
  { name: 'claude', settingsRel: '.claude/settings.json', phases: CLAUDE_PHASES },
  { name: 'gemini', settingsRel: '.gemini/settings.json', phases: GEMINI_PHASES },
];

function hookCommandFor(shimPath, subcommand) {
  return `${shimPath} ${subcommand}`;
}

function readJsonOrEmpty(path) {
  if (!existsSync(path)) return { ok: true, value: {} };
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    return { ok: false, reason: `read failed: ${e.message}` };
  }
  if (raw.trim() === '') return { ok: true, value: {} };
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, reason: 'top-level JSON must be an object' };
    }
    return { ok: true, value: parsed };
  } catch (e) {
    return { ok: false, reason: `malformed JSON: ${e.message}` };
  }
}

function atomicWriteJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o644 });
  renameSync(tmp, path);
  chmodSync(path, 0o644);
}

/**
 * Check whether a phase array (e.g. settings.hooks.PreToolUse) already
 * contains an entry whose hooks include our exact command string.
 */
function findEntryWithCommand(phaseArr, command) {
  if (!Array.isArray(phaseArr)) return -1;
  for (let i = 0; i < phaseArr.length; i++) {
    const entry = phaseArr[i];
    if (!entry || typeof entry !== 'object') continue;
    const hooks = Array.isArray(entry.hooks) ? entry.hooks : [];
    if (hooks.some((h) => h && h.type === 'command' && h.command === command)) return i;
  }
  return -1;
}

function buildEntry({ matcher, command }) {
  const e = {};
  if (matcher !== null && matcher !== undefined) e.matcher = matcher;
  e.hooks = [{ type: 'command', command }];
  return e;
}

function mergePhase(phaseArr, entry) {
  if (!Array.isArray(phaseArr)) return [entry];
  return [...phaseArr, entry];
}

function removeCommandFromPhase(phaseArr, command) {
  if (!Array.isArray(phaseArr)) return { arr: phaseArr, removed: 0 };
  const out = [];
  let removed = 0;
  for (const entry of phaseArr) {
    if (!entry || typeof entry !== 'object' || !Array.isArray(entry.hooks)) {
      out.push(entry);
      continue;
    }
    const filteredHooks = entry.hooks.filter(
      (h) => !(h && h.type === 'command' && h.command === command),
    );
    if (filteredHooks.length === entry.hooks.length) {
      out.push(entry);
      continue;
    }
    removed += entry.hooks.length - filteredHooks.length;
    if (filteredHooks.length === 0) {
      // Drop the entry entirely if its hook list is now empty.
      continue;
    }
    out.push({ ...entry, hooks: filteredHooks });
  }
  return { arr: out, removed };
}

function manifestPath() {
  return join(paths().home, 'installed-hooks.json');
}

/**
 * Install robin hook entries into `<homeDir>/.claude/settings.json` and
 * `<homeDir>/.gemini/settings.json`. Foreign entries are preserved.
 * Idempotent: re-running adds nothing if the entries are already present.
 *
 * Writes a manifest at `<robinHome>/installed-hooks.json` recording exactly
 * which entries we own (per host) so uninstall can be precise.
 *
 * @param {{homeDir: string, packageRoot: string}} args
 * @returns {Promise<{addedByHost: Record<string, number>}>}
 */
export async function installHooksToSettings({ homeDir, packageRoot }) {
  if (!homeDir || typeof homeDir !== 'string') {
    throw new TypeError('installHooksToSettings: homeDir is required');
  }
  if (!packageRoot || typeof packageRoot !== 'string') {
    throw new TypeError('installHooksToSettings: packageRoot is required');
  }
  const shimPath = join(packageRoot, 'bin', 'robin-hook.sh');
  const addedByHost = {};
  const manifest = {};

  for (const host of HOSTS) {
    const settingsPath = join(homeDir, host.settingsRel);
    const read = readJsonOrEmpty(settingsPath);
    if (!read.ok) {
      process.stderr.write(
        `Robin: skipping hook install for ${host.name}: ${read.reason} (${settingsPath})\n`,
      );
      continue;
    }
    const settings = read.value;
    if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) {
      settings.hooks = {};
    }

    let added = 0;
    const owned = [];
    for (const def of host.phases) {
      const command = hookCommandFor(shimPath, def.subcommand);
      const phaseArr = settings.hooks[def.phase];
      const idx = findEntryWithCommand(phaseArr, command);
      if (idx === -1) {
        const entry = buildEntry({ matcher: def.matcher, command });
        settings.hooks[def.phase] = mergePhase(phaseArr, entry);
        added += 1;
      }
      // Always record the owned entry in the manifest, regardless of whether
      // we just added it now or it was present from a prior install.
      const ownedEntry = { phase: def.phase, command };
      if (def.matcher !== null && def.matcher !== undefined) ownedEntry.matcher = def.matcher;
      owned.push(ownedEntry);
    }

    atomicWriteJson(settingsPath, settings);
    addedByHost[host.name] = added;
    manifest[host.name] = owned;
  }

  const mPath = manifestPath();
  mkdirSync(dirname(mPath), { recursive: true });
  atomicWriteJson(mPath, manifest);
  return { addedByHost };
}

/**
 * Remove robin-owned hook entries from settings, using the manifest as the
 * source of truth. Falls back to a scan-and-prefix-match if the manifest is
 * missing.
 *
 * @param {{homeDir: string, packageRoot?: string}} args
 * @returns {Promise<{removedByHost: Record<string, number>}>}
 */
export async function uninstallHooksFromSettings({ homeDir, packageRoot }) {
  if (!homeDir || typeof homeDir !== 'string') {
    throw new TypeError('uninstallHooksFromSettings: homeDir is required');
  }
  const removedByHost = {};
  const manifest = await readInstalledHooks();

  for (const host of HOSTS) {
    const settingsPath = join(homeDir, host.settingsRel);
    if (!existsSync(settingsPath)) continue;
    const read = readJsonOrEmpty(settingsPath);
    if (!read.ok) {
      process.stderr.write(
        `Robin: cannot parse ${settingsPath} during uninstall: ${read.reason}\n`,
      );
      continue;
    }
    const settings = read.value;
    if (!settings.hooks || typeof settings.hooks !== 'object') {
      removedByHost[host.name] = 0;
      continue;
    }

    let removed = 0;
    if (manifest && Array.isArray(manifest[host.name])) {
      // Manifest path: remove the exact commands we recorded.
      for (const entry of manifest[host.name]) {
        if (!entry || typeof entry.command !== 'string') continue;
        const phaseArr = settings.hooks[entry.phase];
        const r = removeCommandFromPhase(phaseArr, entry.command);
        removed += r.removed;
        if (Array.isArray(r.arr) && r.arr.length === 0) {
          delete settings.hooks[entry.phase];
        } else {
          settings.hooks[entry.phase] = r.arr;
        }
      }
    } else {
      // Fallback: scan for any command starting with the shim prefix.
      const prefix = packageRoot ? join(packageRoot, 'bin', 'robin-hook.sh') : null;
      for (const phase of Object.keys(settings.hooks)) {
        const phaseArr = settings.hooks[phase];
        if (!Array.isArray(phaseArr)) continue;
        const out = [];
        for (const entry of phaseArr) {
          if (!entry || typeof entry !== 'object' || !Array.isArray(entry.hooks)) {
            out.push(entry);
            continue;
          }
          const filteredHooks = entry.hooks.filter((h) => {
            if (!h || h.type !== 'command' || typeof h.command !== 'string') return true;
            if (prefix && h.command.startsWith(prefix)) return false;
            // Last-ditch: any command that contains '/bin/robin-hook.sh ' looks like ours.
            if (/\/bin\/robin-hook\.sh(\s|$)/.test(h.command)) return false;
            return true;
          });
          if (filteredHooks.length === entry.hooks.length) {
            out.push(entry);
            continue;
          }
          removed += entry.hooks.length - filteredHooks.length;
          if (filteredHooks.length > 0) {
            out.push({ ...entry, hooks: filteredHooks });
          }
        }
        if (out.length === 0) {
          delete settings.hooks[phase];
        } else {
          settings.hooks[phase] = out;
        }
      }
    }

    // Drop hooks key entirely if it's now empty.
    if (settings.hooks && Object.keys(settings.hooks).length === 0) {
      // biome-ignore lint/performance/noDelete: must remove the key, not set to undefined (JSON-serialized output diverges)
      delete settings.hooks;
    }
    atomicWriteJson(settingsPath, settings);
    removedByHost[host.name] = removed;
  }

  // Delete manifest after success.
  const mPath = manifestPath();
  if (existsSync(mPath)) {
    try {
      rmSync(mPath, { force: true });
    } catch {
      // Non-fatal.
    }
  }
  return { removedByHost };
}

/**
 * Read the installed-hooks manifest, or null if absent / unreadable.
 */
export async function readInstalledHooks() {
  const mPath = manifestPath();
  if (!existsSync(mPath)) return null;
  try {
    const raw = readFileSync(mPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Confirm robin is resolvable for hook execution: either `robin` exists on
 * the PATH of a fresh login shell, OR our shipped shim exists+executable.
 * Throws if neither is available — hooks would silently fail at fire-time.
 *
 * @param {{packageRoot: string}} args
 * @returns {Promise<{robinOnPath: boolean, shimPath: string}>}
 */
export async function validateRobinResolvable({ packageRoot }) {
  if (!packageRoot || typeof packageRoot !== 'string') {
    throw new TypeError('validateRobinResolvable: packageRoot is required');
  }
  const shimPath = join(packageRoot, 'bin', 'robin-hook.sh');

  const probe = spawnSync('/bin/sh', ['-lc', 'command -v robin'], { encoding: 'utf8' });
  const robinOnPath =
    probe.status === 0 && typeof probe.stdout === 'string' && probe.stdout.trim() !== '';

  const shimExists = existsSync(shimPath);
  let shimExec = false;
  if (shimExists) {
    try {
      accessSync(shimPath, constants.X_OK);
      shimExec = true;
    } catch {
      shimExec = false;
    }
  }

  if (!robinOnPath && !(shimExists && shimExec)) {
    const reasons = [];
    if (!robinOnPath) reasons.push('`robin` not on PATH from /bin/sh -lc');
    if (!shimExists) reasons.push(`shim missing at ${shimPath}`);
    else if (!shimExec) reasons.push(`shim not executable at ${shimPath}`);
    throw new Error(`hooks unreachable: ${reasons.join('; ')}`);
  }
  return { robinOnPath, shimPath };
}
