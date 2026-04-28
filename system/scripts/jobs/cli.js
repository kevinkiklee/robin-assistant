// `robin jobs ...` and `robin job ...` CLI surface.
// Pure printf + ANSI; no chalk, no cli-table dep. Designed for sub-100ms cold start.

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { discoverJobs, loadJob } from '../lib/jobs/discovery.js';
import { jobsPaths } from '../lib/jobs/paths.js';
import {
  acquireLock,
  releaseLock,
  readJSON,
} from '../lib/jobs/atomic.js';
import { hostname } from 'node:os';
import { computeNextRun, formatLocal, listJobStates } from '../lib/jobs/state.js';
import { run as runJob } from './runner.js';
import { reconcile } from './reconciler.js';
import { inActiveWindow, validateCron } from '../lib/jobs/cron.js';
import { validateJobDef } from '../lib/jobs/frontmatter.js';

const ANSI = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};
const useColor = !process.env.NO_COLOR && process.stdout.isTTY;
const c = (code, s) => (useColor ? `${code}${s}${ANSI.reset}` : s);

function readWorkspaceConfig(workspaceDir) {
  return readJSON(join(workspaceDir, 'user-data/robin.config.json'), {});
}

function statusColor(status) {
  if (!status) return '—';
  if (status === 'ok') return c(ANSI.green, status);
  if (status === 'failed') return c(ANSI.red, status);
  if (status.startsWith('skipped')) return c(ANSI.dim, status);
  return status;
}

function table(rows, headers, opts = {}) {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => stripAnsi(String(r[i] ?? '—')).length))
  );
  const sep = (ch = '-') => widths.map((w) => ch.repeat(w)).join('  ');
  const line = (cells) =>
    cells
      .map((cell, i) => {
        const s = String(cell ?? '—');
        const len = stripAnsi(s).length;
        return s + ' '.repeat(Math.max(0, widths[i] - len));
      })
      .join('  ');
  const out = [c(ANSI.bold, line(headers)), sep()];
  for (const r of rows) out.push(line(r));
  return out.join('\n');
}

function stripAnsi(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, '');
}

function workspaceDir() {
  return process.env.ROBIN_WORKSPACE || process.cwd();
}

function robinPathBaked() {
  if (process.env.ROBIN_BIN) return process.env.ROBIN_BIN;
  return `${process.execPath} ${join(workspaceDir(), 'bin/robin.js')}`;
}

function tzFromConfig(ws) {
  return readWorkspaceConfig(ws)?.user?.timezone || null;
}

// ---- Commands ----

export function cmdRun(args) {
  const flags = {};
  const positional = [];
  for (const a of args) {
    if (a === '--force') flags.force = true;
    else if (a === '--dry-run') flags.dryRun = true;
    else if (a === '--no-lock') flags.noLock = true;
    else positional.push(a);
  }
  const name = positional[0];
  if (!name) {
    process.stderr.write('usage: robin run <name> [--force | --dry-run | --no-lock]\n');
    process.exit(2);
  }
  return runJob({
    workspaceDir: workspaceDir(),
    name,
    flags,
    onLog: (l) => process.stderr.write(l + '\n'),
  }).then((r) => {
    if (r.status === 'failed') process.exit(r.exitCode || 1);
    process.exit(0);
  });
}

export function cmdJob(args) {
  const sub = args[0];
  const name = args[1];
  if (!sub || !name) {
    process.stderr.write('usage: robin job <acquire|release> <name>\n');
    process.exit(2);
  }
  const paths = jobsPaths(workspaceDir());
  const lockPath = paths.lockFile(name);
  if (sub === 'acquire') {
    const r = acquireLock(lockPath, { host: hostname() });
    process.exit(r === null ? 0 : 1);
  }
  if (sub === 'release') {
    releaseLock(lockPath);
    process.exit(0);
  }
  process.stderr.write(`unknown subcommand: job ${sub}\n`);
  process.exit(2);
}

export function cmdJobsList(args) {
  const json = args.includes('--json');
  const ws = workspaceDir();
  const tz = tzFromConfig(ws);
  const { jobs } = discoverJobs(ws);
  const states = listJobStates(ws);
  const rows = [];
  for (const [name, def] of jobs) {
    const s = states.get(name) || {};
    rows.push({
      name,
      runtime: def.frontmatter.runtime,
      enabled: def.frontmatter.enabled !== false ? 'yes' : 'no',
      schedule: def.frontmatter.schedule || '—',
      last_run_at: s.last_run_at || null,
      last_status: s.last_status || null,
      next_run_at: s.next_run_at || (def.frontmatter.schedule ? computeNextRun(def, new Date()) : null),
    });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name));
  if (json) {
    process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
    return;
  }
  const data = rows.map((r) => [
    r.name,
    r.runtime,
    r.enabled,
    r.schedule,
    r.last_run_at ? formatLocal(r.last_run_at, tz) : '—',
    statusColor(r.last_status),
    r.next_run_at ? formatLocal(r.next_run_at, tz) : '—',
  ]);
  process.stdout.write(
    table(data, ['NAME', 'RUNTIME', 'ENABLED', 'SCHEDULE', 'LAST RUN', 'STATUS', 'NEXT']) + '\n'
  );
}

export function cmdJobsStatus(args) {
  const json = args.includes('--json');
  const positional = args.filter((a) => !a.startsWith('--'));
  const name = positional[0];
  const ws = workspaceDir();
  const tz = tzFromConfig(ws);
  const { jobs } = discoverJobs(ws);
  const states = listJobStates(ws);
  if (!name) {
    const total = jobs.size;
    const enabled = [...jobs.values()].filter((d) => d.frontmatter.enabled !== false).length;
    const failedNow = [...states.values()].filter((s) => s.last_status === 'failed').length;
    if (json) {
      process.stdout.write(JSON.stringify({ total, enabled, failedNow }) + '\n');
      return;
    }
    process.stdout.write(`${total} jobs · ${enabled} enabled · ${failedNow} failed\n`);
    return;
  }
  const def = jobs.get(name);
  if (!def) {
    process.stderr.write(`job not found: ${name}\n`);
    process.exit(1);
  }
  const state = states.get(name) || {};
  if (json) {
    process.stdout.write(JSON.stringify({ ...def.frontmatter, ...state }, null, 2) + '\n');
    return;
  }
  const lines = [];
  lines.push(c(ANSI.bold, name));
  lines.push('─'.repeat(50));
  lines.push(`description    ${def.frontmatter.description}`);
  lines.push(`runtime        ${def.frontmatter.runtime}`);
  lines.push(`enabled        ${def.frontmatter.enabled !== false ? 'yes' : 'no'}`);
  lines.push(`schedule       ${def.frontmatter.schedule || '—'}`);
  lines.push(`active         ${def.frontmatter.active ? JSON.stringify(def.frontmatter.active) : 'always'}`);
  lines.push(`def            ${def.sourcePath}`);
  if (def.overridePath) lines.push(`override       ${def.overridePath}`);
  lines.push('');
  if (state.last_run_at) {
    lines.push(`last run       ${formatLocal(state.last_run_at, tz, { tz: true })} → ${formatLocal(state.last_ended_at, tz, { tz: true })} (${state.last_duration_ms}ms)`);
    lines.push(`status         ${statusColor(state.last_status)}    exit ${state.last_exit_code}`);
    if (state.last_log_path) lines.push(`log            ${state.last_log_path}`);
    if (state.last_summary_path) lines.push(`summary        ${state.last_summary_path}`);
  } else {
    lines.push(`last run       —`);
  }
  if (state.next_run_at) lines.push(`next run       ${formatLocal(state.next_run_at, tz)}`);
  process.stdout.write(lines.join('\n') + '\n');
}

export function cmdJobsLogs(args) {
  const positional = args.filter((a) => !a.startsWith('--'));
  const name = positional[0];
  if (!name) {
    process.stderr.write('usage: robin jobs logs <name> [--full | --tail=N | --list]\n');
    process.exit(2);
  }
  const ws = workspaceDir();
  const paths = jobsPaths(ws);
  const list = args.includes('--list');
  const full = args.includes('--full');
  const tailFlag = args.find((a) => a.startsWith('--tail='));
  const tailN = tailFlag ? Number.parseInt(tailFlag.split('=')[1], 10) : null;

  if (!existsSync(paths.logsDir)) {
    process.stderr.write(`no logs found for ${name}\n`);
    process.exit(0);
  }
  const files = readdirSync(paths.logsDir)
    .filter((f) => f.startsWith(`${name}-`))
    .sort()
    .reverse();
  if (list) {
    if (files.length === 0) {
      process.stdout.write('(no log files)\n');
      return;
    }
    for (const f of files) {
      const st = statSync(join(paths.logsDir, f));
      process.stdout.write(`${new Date(st.mtimeMs).toISOString()}  ${f}\n`);
    }
    return;
  }
  // Pick the most recent .summary.log (default) or .log (--full).
  const target = full
    ? files.find((f) => f.endsWith('.log') && !f.endsWith('.runner.log') && !f.endsWith('.summary.log'))
    : files.find((f) => f.endsWith('.summary.log'));
  if (!target) {
    process.stderr.write(`no ${full ? 'full' : 'summary'} log found for ${name}\n`);
    process.exit(0);
  }
  const content = readFileSync(join(paths.logsDir, target), 'utf-8');
  if (tailN) {
    const tail = content.split('\n').slice(-tailN).join('\n');
    process.stdout.write(tail + '\n');
  } else {
    process.stdout.write(content);
  }
}

export function cmdJobsSync(args) {
  const force = args.includes('--force');
  const ws = workspaceDir();
  const r = reconcile({ workspaceDir: ws, robinPath: robinPathBaked(), force });
  if (args.includes('--json')) {
    process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    return;
  }
  if (typeof r.skipped === 'string') {
    process.stdout.write(`Reconcile skipped: ${r.skipped}\n`);
    return;
  }
  const lines = ['Reconciled jobs:'];
  for (const n of r.added) lines.push(`  + ${n}  installed`);
  for (const n of r.updated) lines.push(`  ~ ${n}  updated`);
  for (const n of r.removed) lines.push(`  - ${n}  removed`);
  for (const n of r.orphansRemoved) lines.push(`  - ${n}  state cleaned`);
  for (const w of r.warnings) lines.push(c(ANSI.yellow, `  ⚠ ${w}`));
  if (r.added.length === 0 && r.removed.length === 0 && r.updated.length === 0 && r.orphansRemoved.length === 0 && r.warnings.length === 0) {
    lines.push('  (no changes)');
  }
  process.stdout.write(lines.join('\n') + '\n');
}

export function cmdJobsEnableDisable(args, enabled) {
  const name = args[0];
  if (!name) {
    process.stderr.write(`usage: robin jobs ${enabled ? 'enable' : 'disable'} <name>\n`);
    process.exit(2);
  }
  const ws = workspaceDir();
  const paths = jobsPaths(ws);
  const userPath = join(paths.userJobsDir, `${name}.md`);
  const sysPath = join(paths.systemJobsDir, `${name}.md`);
  // If user already has a full def, edit its enabled field. Otherwise write a shallow override.
  if (!existsSync(paths.userJobsDir)) mkdirSync(paths.userJobsDir, { recursive: true });
  let content;
  if (existsSync(userPath)) {
    content = readFileSync(userPath, 'utf-8');
    if (/^enabled:\s*\S+/m.test(content)) {
      content = content.replace(/^enabled:\s*\S+/m, `enabled: ${enabled ? 'true' : 'false'}`);
    } else {
      // Insert before the closing --- of frontmatter
      content = content.replace(/^---\s*$/m, (match, offset, full) => {
        // Replace only the second --- (close), not the first (open).
        // Use a state-aware approach instead:
        return match;
      });
      content = content.replace(/(^---\n[\s\S]*?\n)---\n/, `$1enabled: ${enabled ? 'true' : 'false'}\n---\n`);
    }
  } else if (existsSync(sysPath)) {
    content = `---\noverride: "${name}"\nenabled: ${enabled ? 'true' : 'false'}\n---\n`;
  } else {
    process.stderr.write(`job not found: ${name}\n`);
    process.exit(1);
  }
  writeFileSync(userPath, content);
  process.stdout.write(`${enabled ? 'Enabled' : 'Disabled'} ${name} (override at ${userPath})\n`);
  // Trigger a reconcile so the OS scheduler is brought in line immediately.
  cmdJobsSync([]);
}

export function cmdJobsValidate(args) {
  const ws = workspaceDir();
  const positional = args.filter((a) => !a.startsWith('--'));
  const name = positional[0];
  const { jobs, errors } = discoverJobs(ws);
  let exit = 0;
  if (name) {
    const def = jobs.get(name);
    if (!def) {
      process.stderr.write(`job not found: ${name}\n`);
      process.exit(1);
    }
    const r = validateJobDef({ frontmatter: def.frontmatter, body: def.body });
    if (r.valid && def.frontmatter.schedule) {
      const cv = validateCron(def.frontmatter.schedule);
      if (!cv.valid) {
        process.stderr.write(`${name}: invalid cron: ${cv.error}\n`);
        exit = 1;
      } else {
        process.stdout.write(`${name}: ok\n`);
      }
    } else if (r.valid) {
      process.stdout.write(`${name}: ok\n`);
    } else {
      for (const e of r.errors) process.stderr.write(`${name}: ${e}\n`);
      exit = 1;
    }
  } else {
    for (const [n, def] of jobs) {
      const r = validateJobDef({ frontmatter: def.frontmatter, body: def.body });
      const cv = def.frontmatter.schedule ? validateCron(def.frontmatter.schedule) : { valid: true };
      if (r.valid && cv.valid) {
        process.stdout.write(`${n}: ok\n`);
      } else {
        const errs = (r.valid ? [] : r.errors).concat(cv.valid ? [] : [`invalid cron: ${cv.error}`]);
        for (const e of errs) process.stderr.write(`${n}: ${e}\n`);
        exit = 1;
      }
    }
    for (const e of errors) {
      for (const msg of e.errors || []) {
        process.stderr.write(`${e.path || e.name}: ${msg}\n`);
        exit = 1;
      }
    }
  }
  process.exit(exit);
}

export function cmdJobsUpcoming(args) {
  const ws = workspaceDir();
  const paths = jobsPaths(ws);
  if (existsSync(paths.upcomingMd)) {
    process.stdout.write(readFileSync(paths.upcomingMd, 'utf-8'));
  } else {
    process.stdout.write('(no upcoming.md — run `robin jobs sync`)\n');
  }
}

export async function dispatchJobs(args) {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case undefined:
    case 'list':
    case 'ls':
      return cmdJobsList(rest);
    case 'status':
      return cmdJobsStatus(rest);
    case 'logs':
      return cmdJobsLogs(rest);
    case 'sync':
      return cmdJobsSync(rest);
    case 'enable':
      return cmdJobsEnableDisable(rest, true);
    case 'disable':
      return cmdJobsEnableDisable(rest, false);
    case 'validate':
      return cmdJobsValidate(rest);
    case 'upcoming':
      return cmdJobsUpcoming(rest);
    default:
      process.stderr.write(`unknown subcommand: jobs ${sub}\n`);
      process.exit(2);
  }
}
