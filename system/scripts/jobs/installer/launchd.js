// macOS launchd adapter: translates job defs to ~/Library/LaunchAgents plists.

import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseCron } from '../lib/cron.js';

const BASE_PATH = '/usr/local/bin:/usr/bin:/bin';

// Build a PATH that resolves bare `node` and `claude` when launchd execs the
// runner subprocess. The runner's execNode/execAgent invoke them by name, so
// the dirs that hold this node binary and the claude CLI must be on PATH.
export function resolveLaunchdEnvPath() {
  const dirs = new Set();
  // Current node's bin dir (typically nvm or homebrew)
  if (process.execPath) dirs.add(dirname(process.execPath));
  // Look up `claude` via login shell so nvm/asdf/PATH shims resolve correctly
  try {
    const r = spawnSync(process.env.SHELL || '/bin/zsh', ['-l', '-c', 'command -v claude'], {
      stdio: 'pipe',
      timeout: 3000,
    });
    const out = (r.stdout?.toString() || '').trim();
    if (r.status === 0 && out) dirs.add(dirname(out));
  } catch {
    // best effort
  }
  // Common user-local install dirs that frequently host `claude`
  const home = homedir();
  for (const d of [join(home, '.local/bin'), '/opt/homebrew/bin']) {
    if (existsSync(d)) dirs.add(d);
  }
  return [...dirs, ...BASE_PATH.split(':')].join(':');
}

export const LABEL_PREFIX = 'com.robin.';

export function agentsDir() {
  return join(homedir(), 'Library/LaunchAgents');
}

export function plistPath(name) {
  return join(agentsDir(), `${LABEL_PREFIX}${name}.plist`);
}

// Translate a cron expression into one or more StartCalendarInterval dicts.
// Returns null if the expression has more than 96 unique fire times across the
// 5-field representation (heuristic for "too complex"; reject and warn).
export function cronToCalendarIntervals(cronExpr) {
  const c = parseCron(cronExpr);
  const cap = 96;
  const intervals = [];
  // Cartesian product, but skip degenerate any-day matchers
  for (const minute of c.minute) {
    for (const hour of c.hour) {
      const months = c.month.length === 12 ? [null] : c.month;
      const doms = c.dayOfMonth.length === 31 ? [null] : c.dayOfMonth;
      const dows = c.dayOfWeek.length === 7 ? [null] : c.dayOfWeek;
      for (const month of months) {
        for (const day of doms) {
          for (const wd of dows) {
            const entry = { Minute: minute, Hour: hour };
            if (month != null) entry.Month = month;
            if (day != null) entry.Day = day;
            if (wd != null) entry.Weekday = wd;
            intervals.push(entry);
            if (intervals.length > cap) return null;
          }
        }
      }
    }
  }
  return intervals;
}

function escXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function plistDict(obj) {
  const lines = ['<dict>'];
  for (const [k, v] of Object.entries(obj)) {
    lines.push(`<key>${escXml(k)}</key>`);
    if (typeof v === 'number') lines.push(`<integer>${v}</integer>`);
    else if (typeof v === 'string') lines.push(`<string>${escXml(v)}</string>`);
    else if (typeof v === 'boolean') lines.push(v ? '<true/>' : '<false/>');
    else if (Array.isArray(v)) {
      lines.push('<array>');
      for (const item of v) {
        if (typeof item === 'number') lines.push(`<integer>${item}</integer>`);
        else if (typeof item === 'string') lines.push(`<string>${escXml(item)}</string>`);
        else if (typeof item === 'object') lines.push(plistDict(item));
      }
      lines.push('</array>');
    } else if (v && typeof v === 'object') {
      lines.push(plistDict(v));
    }
  }
  lines.push('</dict>');
  return lines.join('\n');
}

export function generatePlist({ name, argv, workspaceDir, schedule, envPath = BASE_PATH, runAtLoad = false }) {
  if (!Array.isArray(argv) || argv.length === 0 || argv.some((t) => typeof t !== 'string' || t.length === 0)) {
    throw new Error('generatePlist: argv must be a non-empty array of non-empty strings');
  }
  const intervals = cronToCalendarIntervals(schedule);
  if (intervals === null) {
    throw new Error(`cron expression too complex for launchd: ${schedule}`);
  }
  const calendar = intervals.length === 1 ? intervals[0] : intervals;
  const dict = {
    Label: `${LABEL_PREFIX}${name}`,
    ProgramArguments: [...argv, 'run', name],
    WorkingDirectory: workspaceDir,
    StartCalendarInterval: calendar,
    StandardOutPath: '/dev/null',
    StandardErrorPath: '/dev/null',
    EnvironmentVariables: {
      PATH: envPath,
      ROBIN_WORKSPACE: workspaceDir,
    },
  };
  if (runAtLoad) dict.RunAtLoad = true;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTD/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    plistDict(dict),
    '</plist>',
    '',
  ].join('\n');
}

export function listEntries() {
  const dir = agentsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.startsWith(LABEL_PREFIX) && f.endsWith('.plist'))
    .map((f) => f.slice(LABEL_PREFIX.length, -'.plist'.length));
}

export function readEntryWorkspace(name) {
  const p = plistPath(name);
  if (!existsSync(p)) return null;
  const content = readFileSync(p, 'utf-8');
  const m = content.match(/<key>WorkingDirectory<\/key>\s*<string>([^<]+)<\/string>/);
  return m ? m[1] : null;
}

function uid() {
  return process.getuid ? process.getuid() : 0;
}

function bootstrapDomain() {
  return `gui/${uid()}`;
}

function launchctl(args) {
  return spawnSync('launchctl', args, { stdio: 'pipe' });
}

export function installEntry({ name, argv, workspaceDir, schedule, envPath = resolveLaunchdEnvPath(), runAtLoad = false }) {
  const dir = agentsDir();
  mkdirSync(dir, { recursive: true });
  const path = plistPath(name);
  const xml = generatePlist({ name, argv, workspaceDir, schedule, envPath, runAtLoad });
  // Idempotency: if the plist content is unchanged, skip the bootout/bootstrap
  // cycle. Otherwise RunAtLoad jobs would fire on every reconcile, including
  // their own dispatch, creating a feedback loop.
  if (existsSync(path)) {
    try {
      const existing = readFileSync(path, 'utf-8');
      if (existing === xml) {
        return { ok: true, stderr: '', unchanged: true };
      }
    } catch {
      // fall through to rewrite
    }
    launchctl(['bootout', `${bootstrapDomain()}/${LABEL_PREFIX}${name}`]);
  }
  writeFileSync(path, xml);
  const r = launchctl(['bootstrap', bootstrapDomain(), path]);
  return { ok: r.status === 0 || r.status == null, stderr: r.stderr?.toString() || '' };
}

export function uninstallEntry(name) {
  launchctl(['bootout', `${bootstrapDomain()}/${LABEL_PREFIX}${name}`]);
  const path = plistPath(name);
  if (existsSync(path)) {
    try {
      unlinkSync(path);
    } catch {
      // ignore
    }
  }
}
