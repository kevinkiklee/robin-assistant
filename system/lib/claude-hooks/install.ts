import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Robin's Claude Code SessionEnd hook posts the session_id + transcript_path that Claude
 * Code emits on stdin to the daemon's HTTP endpoint. The daemon reads the transcript,
 * applies skip rules, dedups, and writes a `session.captured` event into the firehose.
 *
 * Why a curl-based hook instead of a node script:
 *   1. curl ships with macOS; no PATH issues at hook-fire time (v1's hooks died on PATH).
 *   2. The daemon already owns the parsing + skip-rules logic. The hook stays trivial so
 *      a daemon update never breaks Kevin's settings.json — there's nothing here that
 *      needs to evolve with the schema.
 *   3. --max-time 2 keeps the hook from blocking session shutdown if the daemon is down.
 *
 * Discovery: the command string contains the literal `${HOOK_SIGNATURE}` substring so we
 * can find + replace OUR entry without disturbing third-party hooks (vercel, etc.) that
 * may share the SessionEnd lifecycle.
 */
export const HOOK_SIGNATURE = '/hooks/session_end';
export const DEFAULT_PORT = 41273;

export interface InstallOptions {
  /** Override HOME for tests. */
  home?: string;
  /** Override the daemon port. Defaults to 41273. */
  port?: number;
}

export interface InstallResult {
  path: string;
  /** True when a prior Robin hook entry was replaced; false if this is a fresh install. */
  replaced: boolean;
}

interface HookEntry {
  type: string;
  command: string;
}

interface MatcherGroup {
  hooks?: HookEntry[];
}

interface SettingsShape {
  hooks?: {
    SessionEnd?: MatcherGroup[];
    [k: string]: MatcherGroup[] | undefined;
  };
  [k: string]: unknown;
}

export function robinHookCommand(port: number = DEFAULT_PORT): string {
  // --max-time 2: don't block session shutdown if the daemon is down.
  // --data-binary @-: stream Claude Code's stdin payload through verbatim.
  return `curl -s --max-time 2 -X POST http://127.0.0.1:${port}/hooks/session_end -H 'Content-Type: application/json' --data-binary @-`;
}

/**
 * Add (or replace) Robin's SessionEnd hook entry in ~/.claude/settings.json without
 * touching unrelated keys or third-party hook entries. The function is idempotent —
 * calling it repeatedly produces the same end state.
 */
export function installSessionEndHook(opts: InstallOptions = {}): InstallResult {
  const home = opts.home ?? homedir();
  const port = opts.port ?? DEFAULT_PORT;
  const settingsPath = join(home, '.claude', 'settings.json');

  let settings: SettingsShape = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as SettingsShape;
    } catch {
      // Corrupt JSON — start fresh rather than blow up. Better to install the hook
      // than refuse on a stale parse error; the original is still on disk to recover.
      settings = {};
    }
  }

  if (!settings.hooks) settings.hooks = {};
  const existingGroups: MatcherGroup[] = settings.hooks.SessionEnd ?? [];

  const command = robinHookCommand(port);
  let replaced = false;

  // Strip any prior Robin entries (by HOOK_SIGNATURE substring) from each group,
  // then drop groups that become empty. This lets us update the command (e.g.
  // changed port) without leaving stale duplicates behind.
  const cleanedGroups: MatcherGroup[] = [];
  for (const group of existingGroups) {
    const filtered = (group.hooks ?? []).filter((h) => {
      const isRobin = typeof h.command === 'string' && h.command.includes(HOOK_SIGNATURE);
      if (isRobin) replaced = true;
      return !isRobin;
    });
    if (filtered.length > 0) cleanedGroups.push({ ...group, hooks: filtered });
  }

  // Append Robin's hook as its own group so it sits cleanly alongside other tools.
  cleanedGroups.push({ hooks: [{ type: 'command', command }] });
  settings.hooks.SessionEnd = cleanedGroups;

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  return { path: settingsPath, replaced };
}

/**
 * Remove Robin's SessionEnd hook entry from settings.json (idempotent — a no-op if
 * none was installed). Other hook entries are preserved.
 */
export function uninstallSessionEndHook(opts: InstallOptions = {}): InstallResult {
  const home = opts.home ?? homedir();
  const settingsPath = join(home, '.claude', 'settings.json');
  if (!existsSync(settingsPath)) return { path: settingsPath, replaced: false };

  let settings: SettingsShape;
  try {
    settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as SettingsShape;
  } catch {
    return { path: settingsPath, replaced: false };
  }

  const existingGroups: MatcherGroup[] = settings.hooks?.SessionEnd ?? [];
  let replaced = false;
  const cleaned: MatcherGroup[] = [];
  for (const group of existingGroups) {
    const filtered = (group.hooks ?? []).filter((h) => {
      const isRobin = typeof h.command === 'string' && h.command.includes(HOOK_SIGNATURE);
      if (isRobin) replaced = true;
      return !isRobin;
    });
    if (filtered.length > 0) cleaned.push({ ...group, hooks: filtered });
  }
  if (!settings.hooks) settings.hooks = {};
  if (cleaned.length === 0) {
    delete settings.hooks.SessionEnd;
  } else {
    settings.hooks.SessionEnd = cleaned;
  }
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  return { path: settingsPath, replaced };
}
