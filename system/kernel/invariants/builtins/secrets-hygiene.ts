import { chmodSync, existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { readDeliveries } from '../../../lib/secrets/deliveries.ts';
import { skippedRedactFiles } from '../../../lib/secrets/hooks/redact-policy.ts';
import {
  defaultDistRoot,
  installSecretHooks,
  SECRET_HOOK_SIGNATURE,
} from '../../../lib/secrets/install.ts';
import { installRuleFile } from '../../../lib/secrets/rule-file.ts';
import { secretsPaths } from '../../../lib/secrets/store.ts';
import { isExpired, readOp, readWindow } from '../../../lib/secrets/window.ts';
import type { Invariant } from '../types.ts';

const OP_STALE_MS = 3_600_000;
const EVENTS = ['PreToolUse', 'PostToolUse'] as const;
const TELEMETRY = /^(OTEL_|CLAUDE_CODE_ENABLE_TELEMETRY$)/;

interface HookGroup {
  hooks?: { command?: unknown }[];
}
interface Settings {
  env?: Record<string, unknown>;
  hooks?: Record<string, HookGroup[] | undefined>;
}

function readSettings(path: string): Settings | 'corrupt' | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Settings;
  } catch {
    return 'corrupt';
  }
}

function secretCommands(s: Settings, event: string): string[] {
  const out: string[] = [];
  const groups = s.hooks?.[event];
  for (const g of Array.isArray(groups) ? groups : []) {
    const hooks = g?.hooks;
    for (const h of Array.isArray(hooks) ? hooks : []) {
      if (typeof h?.command === 'string' && h.command.includes(SECRET_HOOK_SIGNATURE)) {
        out.push(h.command);
      }
    }
  }
  return out;
}

interface Sensitive {
  /** Regular files to check and chmod (explicit paths and non-symlink backups). */
  files: string[];
  /** Glob-discovered backups that are symlinks: reported, never chmod-ed. */
  symlinks: string[];
}

/** Files that must be 0600: the vault, Robin env files, delivery targets, and their backups. */
function sensitiveFiles(userData: string, problems: string[]): Sensitive {
  const sp = secretsPaths(userData);
  const files = new Set<string>([sp.vault, sp.robinEnv, sp.daemonEnv]);
  try {
    for (const targets of Object.values(readDeliveries(userData))) {
      for (const t of targets) {
        if (t.kind === 'env-local' || t.kind === 'secret-file') files.add(t.path);
      }
    }
  } catch {
    problems.push(`${sp.deliveries} is unreadable (corrupt delivery registry)`);
  }
  const symlinks: string[] = [];
  for (const f of [...files]) {
    const dir = dirname(f);
    const prefix = `${basename(f)}.bak-`;
    try {
      for (const e of readdirSync(dir)) {
        if (!e.startsWith(prefix)) continue;
        const full = join(dir, e);
        try {
          if (lstatSync(full).isSymbolicLink()) symlinks.push(full);
          else files.add(full);
        } catch {
          // vanished between readdir and lstat
        }
      }
    } catch {
      // directory absent: nothing to back up
    }
  }
  return { files: [...files].filter((f) => existsSync(f)), symlinks };
}

/** Loose-mode files; an unreadable one goes to `unreadable` instead of throwing. */
function loosePerms(
  userData: string,
  problems: string[],
  unreadable: string[] = [],
  symlinks: string[] = [],
): string[] {
  const loose: string[] = [];
  const found = sensitiveFiles(userData, problems);
  symlinks.push(...found.symlinks);
  for (const f of found.files) {
    try {
      if ((statSync(f).mode & 0o077) !== 0) loose.push(f);
    } catch {
      unreadable.push(f);
    }
  }
  return loose;
}

function isSetUp(opts: { userData: string }, home: string, settings: Settings | 'corrupt' | null) {
  if (existsSync(secretsPaths(opts.userData).vault)) return true;
  if (existsSync(join(home, '.claude', 'rules', 'secrets.md'))) return true;
  if (settings === 'corrupt') return false;
  return settings ? EVENTS.some((e) => secretCommands(settings, e).length > 0) : false;
}

/**
 * Checks the key manager's setup: hooks installed and pointing at real files,
 * rule file present, secret files 0600, no stale window or op, no telemetry
 * env that could ship key-bearing tool output. Messages name files and
 * settings, never values.
 */
export function secretsHygieneInvariant(opts: {
  userData: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  nodeBin?: string;
  distRoot?: string;
  nowMs?: () => number;
}): Invariant {
  const home = () => opts.home ?? homedir();
  const settingsPath = () => join(home(), '.claude', 'settings.json');
  return {
    name: 'secrets.hygiene',
    severity: 'warning',
    symptom: 'The secret key manager is not fully set up, or a key file is too open.',
    cause:
      'Hooks or the rule file were removed, a secrets file lost its 0600 mode, a key window or op was left open, or Claude telemetry env is set.',
    fix: 'Run `robin doctor --fix` (re-installs hooks and the rule file, chmods files) or `pnpm build` then `robin secret install`. Unset OTEL_* / CLAUDE_CODE_ENABLE_TELEMETRY yourself.',
    check: () => {
      try {
        return runCheck();
      } catch (e) {
        return { ok: false, message: `secrets hygiene check failed: ${(e as Error).message}` };
      }
    },
    repair: () => {
      if (!isSetUp(opts, home(), readSettings(settingsPath()))) return;
      const scratch: string[] = [];
      for (const f of loosePerms(opts.userData, scratch)) chmodSync(f, 0o600);
      installSecretHooks({
        home: home(),
        userData: opts.userData,
        nodeBin: opts.nodeBin,
        distRoot: opts.distRoot ?? defaultDistRoot(),
      });
      installRuleFile(home());
    },
  };

  function runCheck(): { ok: boolean; message?: string } {
    const problems: string[] = [];
    const sPath = settingsPath();
    const settings = readSettings(sPath);
    if (!isSetUp(opts, home(), settings)) return { ok: true, message: 'key manager not set up' };
    if (settings === 'corrupt') {
      problems.push(`${sPath} is not valid JSON`);
    } else {
      for (const event of EVENTS) {
        if (!settings || secretCommands(settings, event).length === 0) {
          problems.push(`secret ${event} hook missing from ${sPath}`);
        }
      }
      if (settings) {
        const missing = new Set<string>();
        for (const event of EVENTS) {
          for (const cmd of secretCommands(settings, event)) {
            const m =
              /ROBIN_USER_DATA_DIR='[^']*' '([^']+)' '([^']+\/lib\/secrets\/hooks\/[^']+)'/.exec(
                cmd,
              );
            if (!m) {
              problems.push(
                `unrecognized secret hook command in ${sPath} — run robin secret install`,
              );
              continue;
            }
            for (const p of [m[1], m[2]]) if (!existsSync(p)) missing.add(p);
          }
        }
        for (const p of missing) {
          problems.push(
            `${p} referenced by the secret hooks does not exist (run pnpm build, then robin secret install)`,
          );
        }
      }
    }
    const rule = join(home(), '.claude', 'rules', 'secrets.md');
    if (!existsSync(rule)) problems.push(`rule file ${rule} missing`);

    const unreadable: string[] = [];
    const symlinks: string[] = [];
    for (const f of loosePerms(opts.userData, problems, unreadable, symlinks)) {
      problems.push(`${f} is not mode 0600`);
    }
    for (const f of unreadable) problems.push(`${f} could not be stat-ed`);
    for (const f of symlinks) problems.push(`symlinked backup ${f}`);

    const list = secretsPaths(opts.userData).redactFiles;
    try {
      for (const s of skippedRedactFiles(opts.userData)) {
        problems.push(`${s.path} (listed in ${list}) is skipped by redaction: ${s.reason}`);
      }
    } catch {
      problems.push(`${list} is unreadable, so the redaction hook withholds all output`);
    }

    const nowMs = (opts.nowMs ?? Date.now)();
    try {
      const w = readWindow(opts.userData);
      if (w && isExpired(w, new Date(nowMs))) {
        const wp = secretsPaths(opts.userData).window;
        problems.push(
          w.status === 'open'
            ? `${wp} is past its expiry (stale key window)`
            : `${wp}: secret window left over — close the key tab or run \`robin secret abort\``,
        );
      }
    } catch {
      problems.push(`${secretsPaths(opts.userData).window} is unreadable (invalid window file)`);
    }
    const op = readOp(opts.userData);
    if (op) {
      const started = new Date(op.startedAt).getTime();
      if (!Number.isFinite(started) || nowMs - started > OP_STALE_MS) {
        problems.push(`${secretsPaths(opts.userData).op} is over 1h old (stale pending op)`);
      }
    }

    const env = opts.env ?? process.env;
    const names = new Set(Object.keys(env).filter((k) => TELEMETRY.test(k) && env[k]));
    if (settings && settings !== 'corrupt') {
      for (const k of Object.keys(
        settings.env && typeof settings.env === 'object' ? settings.env : {},
      )) {
        if (TELEMETRY.test(k)) names.add(`${k} (settings.json env)`);
      }
    }
    if (names.size > 0) {
      problems.push(
        `telemetry env set: ${[...names].join(', ')} — tool output may leave this Mac; unset it`,
      );
    }
    return problems.length === 0 ? { ok: true } : { ok: false, message: problems.join('; ') };
  }
}
